// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

import { hash, verify } from "@node-rs/argon2";

/** Argon2id is the library default. These three values are the panel policy. */
const options = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

/** A short stand-in for the bundled 10,000-password list. Username equality is checked separately. */
const commonPasswords = new Set([
  "password",
  "password1",
  "password123",
  "1234567890",
  "123456789",
  "12345678",
  "qwerty123",
  "qwertyuiop",
  "iloveyou",
  "admin123",
  "letmein",
  "welcome1",
  "changeme",
  "passw0rd",
]);

export function hashPassword(password: string): Promise<string> {
  return hash(password, options);
}

export function verifyPassword(hashed: string, password: string): Promise<boolean> {
  return verify(hashed, password);
}

export function passwordProblem(password: string, username: string): string | null {
  if (password.length < 10 || password.length > 128) return "Use 10 to 128 characters.";
  if (password.toLowerCase() === username.toLowerCase())
    return "Don't use your username as the password.";
  if (commonPasswords.has(password.toLowerCase())) return "That password is too common.";
  return null;
}

const usernamePattern = /^[a-zA-Z0-9._-]{1,64}$/;

export function usernameProblem(username: string): string | null {
  if (!usernamePattern.test(username)) {
    return "Use 1 to 64 characters: letters, numbers, dot, underscore, or hyphen.";
  }
  return null;
}
