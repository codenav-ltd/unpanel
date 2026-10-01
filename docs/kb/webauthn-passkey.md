# WebAuthn and Passkeys

> Applies to: `apps/panel/src/features/auth/webauthn/`, `apps/web/src/pages/login/`. Verification markers: see [README](./README.md).
> References: [WebAuthn Level 3](https://www.w3.org/TR/webauthn-3/), [SimpleWebAuthn docs](https://simplewebauthn.dev/docs/), [passkeys.dev](https://passkeys.dev/)

## 1. RP ID and origin ✅

- The **RP ID** is a registrable domain suffix of the page's origin: on `https://panel.example.com`, valid RP IDs are `panel.example.com` or `example.com` (not `com`).
- **IP addresses cannot be RP IDs.** On `https://203.0.113.10:28517` passkeys do not work at all.
- WebAuthn requires a secure context: HTTPS, or `http://localhost`.
- Browsers may refuse WebAuthn on pages with certificate errors, even after the user clicks through a self-signed warning ⚠️ (behavior differs by browser; verify with the target browsers). Treat "trusted certificate + domain" as the requirement.
- Passkeys are bound to the RP ID. Changing the panel domain (or RP ID) makes existing passkeys unusable; the panel stores `rp_id` per passkey to warn before such a change.
- Choosing the parent domain (`example.com`) as RP ID keeps passkeys valid across subdomain changes, but any compromised sibling subdomain could then run WebAuthn ceremonies for our RP ID. Default: the exact panel host.

## 2. SimpleWebAuthn v13+ API (current: v14) ✅

Server (`@simplewebauthn/server`):

```ts
const options = await generateRegistrationOptions({
  rpName: "Unpanel",
  rpID,
  userName: user.username,
  userID: webauthnUserIdBytes,          // random 32 bytes per user, not the DB id
  attestationType: "none",
  excludeCredentials: passkeys.map((p) => ({ id: p.id, transports: p.transports })),
  authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
});

const { verified, registrationInfo } = await verifyRegistrationResponse({
  response: body,
  expectedChallenge: storedChallenge,
  expectedOrigin: origin,
  expectedRPID: rpID,
});
// registrationInfo.credential: { id, publicKey, counter, transports }
// registrationInfo.credentialDeviceType: "singleDevice" | "multiDevice"
// registrationInfo.credentialBackedUp: boolean

const authOptions = await generateAuthenticationOptions({ rpID, allowCredentials: [] /* usernameless */ });

const { verified, authenticationInfo } = await verifyAuthenticationResponse({
  response: body,
  expectedChallenge: storedChallenge,
  expectedOrigin: origin,
  expectedRPID: rpID,
  credential: { id: p.id, publicKey: p.publicKey, counter: p.counter, transports: p.transports },
});
// persist authenticationInfo.newCounter
```

Browser (`@simplewebauthn/browser`): `startRegistration({ optionsJSON })`, `startAuthentication({ optionsJSON, useBrowserAutofill })`, `browserSupportsWebAuthnAutofill()`.

`expectedOrigin` and `expectedRPID` accept arrays for multi-origin setups.

## 3. Conditional UI (passkey autofill) ✅

- The username input gets `autocomplete="username webauthn"`.
- On page load, call `startAuthentication({ optionsJSON, useBrowserAutofill: true })` (which uses `mediation: "conditional"`); the browser offers passkeys in the autofill dropdown.
- Only one pending WebAuthn request is allowed; abort the conditional request before starting a modal one (the library handles this when using its helpers).

## 4. Counters and backup flags ✅

- Synced passkeys (iCloud Keychain, Google Password Manager, …) usually report **counter 0 forever**. Only treat a counter as a clone signal when it is non-zero and does not increase.
- Authenticator data flags: **BE** (backup eligible) and **BS** (backed up). `credentialDeviceType = "multiDevice"` means BE was set. Show "synced" vs "device-bound" in the UI.
- Attestation: we use `none`. We do not restrict authenticator models.

## 5. User handles ✅

- `userID` (user handle) must not contain personal data; use 32 random bytes per user, stored as `webauthn_user_id`, fixed for the user's lifetime.
- With usernameless login, the assertion returns `userHandle`; look the user up by it, then check that the credential belongs to that user.

## 6. Related Origin Requests ⚠️

WebAuthn Level 3 allows an RP to list other origins that may use its RP ID via `https://<rpID>/.well-known/webauthn`. Browser support is incomplete as of 2026; not used in v1.

## 7. Testing ✅

Chrome DevTools Protocol provides a virtual authenticator: `WebAuthn.enable`, then `WebAuthn.addVirtualAuthenticator` with `{protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true}`. Playwright can send these via `page.context().newCDPSession(page)`. Use it for registration, login, conditional UI, and sudo tests.

## 8. Pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| `SecurityError: The operation is insecure` / RP ID invalid | Accessing by IP, or RP ID not a suffix of the origin | Use the configured domain |
| Passkeys stop working after a domain change | Bound to the old RP ID | Re-register; the panel warns before changing RP ID |
| Login with a passkey works on one device, not another | Device-bound credential (security key or non-synced) | Register a passkey per device, or use a synced provider |
| `Unexpected authentication response origin` | `public_url`/origin mismatch (e.g. port or proxy) | Set `server.origins` correctly |
