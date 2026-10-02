// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { createPrivateKey, randomBytes, webcrypto, X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { createSecureContext } from "node:tls";
import {
  BasicConstraintsExtension,
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  SubjectAlternativeNameExtension,
  X509CertificateGenerator,
} from "@peculiar/x509";

export interface TlsMaterial {
  cert: string;
  key: string;
}

export class CertificateError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly retryAt = 0,
  ) {
    super(message);
    this.name = "CertificateError";
  }
}

export function normalizeHost(input: string, domainOnly = false): string {
  const raw = input
    .trim()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (!domainOnly && isIP(raw)) return raw;
  const host = domainToASCII(raw).toLowerCase();
  if (
    !host ||
    host.length > 253 ||
    (domainOnly && (!host.includes(".") || isIP(host))) ||
    host.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    throw new CertificateError(
      domainOnly
        ? "Enter a domain such as panel.example.com. HTTP-01 does not support wildcards here."
        : "Enter a hostname or IP address, without a scheme, port, or path.",
    );
  }
  return host;
}

export function inspectMaterial(
  material: TlsMaterial,
  host?: string,
  now = Date.now(),
): {
  subject: string;
  issuer: string;
  names: string;
  fingerprint: string;
  notBefore: number;
  notAfter: number;
  selfSigned: boolean;
} {
  if (material.cert.length > 48_000 || material.key.length > 16_000) {
    throw new CertificateError("The certificate chain or private key is too large.");
  }
  try {
    const blocks = material.cert.match(
      /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
    );
    if (
      !blocks?.length ||
      material.cert
        .replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, "")
        .trim()
    ) {
      throw new CertificateError("Use a PEM certificate chain, with the server certificate first.");
    }
    const chain = blocks.map((pem) => new X509Certificate(pem));
    const leaf = chain[0];
    if (!leaf) throw new CertificateError("A server certificate is required.");
    if (leaf.ca)
      throw new CertificateError(
        "A CA certificate cannot be used as the panel's server certificate.",
      );
    if (!leaf.checkPrivateKey(createPrivateKey(material.key))) {
      throw new CertificateError("The private key does not match the server certificate.");
    }
    for (const [i, cert] of chain.entries()) {
      if (Date.parse(cert.validFrom) > now || Date.parse(cert.validTo) <= now) {
        throw new CertificateError("The certificate chain is expired or not valid yet.");
      }
      const issuer = chain[i + 1];
      if (issuer && (!issuer.ca || !cert.checkIssued(issuer) || !cert.verify(issuer.publicKey))) {
        throw new CertificateError("The certificate chain is incomplete or in the wrong order.");
      }
    }
    if (leaf.keyUsage && !leaf.keyUsage.includes("1.3.6.1.5.5.7.3.1")) {
      throw new CertificateError("The certificate is not valid for TLS server authentication.");
    }
    if (host && !(isIP(host) ? leaf.checkIP(host) : leaf.checkHost(host, { subject: "never" }))) {
      throw new CertificateError(
        "The certificate does not cover the panel hostname or IP address.",
      );
    }
    createSecureContext({ ...material, minVersion: "TLSv1.2" });
    return {
      subject: leaf.subject,
      issuer: leaf.issuer,
      names: leaf.subjectAltName ?? "",
      fingerprint: leaf.fingerprint256,
      notBefore: Date.parse(leaf.validFrom),
      notAfter: Date.parse(leaf.validTo),
      selfSigned: leaf.subject === leaf.issuer && leaf.verify(leaf.publicKey),
    };
  } catch (error) {
    if (error instanceof CertificateError) throw error;
    throw new CertificateError(
      "Could not read this certificate and unencrypted PEM private key. Check their format and try again.",
    );
  }
}

export async function selfSignedCertificate(input: string): Promise<TlsMaterial> {
  const host = normalizeHost(input);
  const algorithm = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
  const keys = await webcrypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
  const cert = await X509CertificateGenerator.createSelfSigned({
    serialNumber: randomBytes(16).toString("hex"),
    name: "CN=Unpanel",
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 365 * 86400_000),
    signingAlgorithm: algorithm,
    keys,
    extensions: [
      new BasicConstraintsExtension(false, undefined, true),
      new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
      new ExtendedKeyUsageExtension(["1.3.6.1.5.5.7.3.1"]),
      new SubjectAlternativeNameExtension([{ type: isIP(host) ? "ip" : "dns", value: host }]),
    ],
  });
  const der = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", keys.privateKey));
  const key = createPrivateKey({ key: der, format: "der", type: "pkcs8" })
    .export({ format: "pem", type: "pkcs8" })
    .toString();
  return { cert: cert.toString("pem"), key };
}
