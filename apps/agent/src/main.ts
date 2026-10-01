// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { PROTOCOL_VERSION } from "@unpanel/protocol";
import { product } from "@unpanel/shared";

if (process.argv.includes("--version")) {
  process.stdout.write(`${product.agentBin} ${product.version} (protocol ${PROTOCOL_VERSION})\n`);
} else {
  process.stdout.write(
    `${product.name} agent skeleton. Not connecting yet. Run with --version to print the version.\n`,
  );
}
