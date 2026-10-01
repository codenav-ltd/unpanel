# TOTP

> Applies to: `apps/panel/src/features/auth/totp/`. Verification markers: see [README](./README.md).
> References: [RFC 6238](https://www.rfc-editor.org/rfc/rfc6238), [RFC 4226 (HOTP)](https://www.rfc-editor.org/rfc/rfc4226), [Key URI format](https://github.com/google/google-authenticator/wiki/Key-Uri-Format)

## 1. Parameters ✅

| Parameter | Value | Why |
|---|---|---|
| Algorithm | HMAC-SHA1 | The only algorithm every authenticator app supports reliably |
| Digits | 6 | Universal |
| Period | 30 s | Universal |
| Secret | 20 random bytes (160 bits), base32 without padding | RFC 4226 recommends ≥ 128 bits; 160 bits matches SHA1's block usage |

Many apps ignore `algorithm`, `digits`, and `period` in the URI, so non-default values cause silent mismatches.

## 2. Provisioning URI ✅

```
otpauth://totp/Panel:alice?secret=JBSWY3DPEHPK3PXP&issuer=Panel&algorithm=SHA1&digits=6&period=30
```

- Label `Issuer:account`, URL-encoded; `issuer` parameter repeated (some apps use one, some the other).
- Rendered as a QR code in the browser; the secret is also shown as text for manual entry.
- Enrollment is confirmed only after the user enters a valid code.

## 3. Algorithm ✅

```
T       = floor(unixSeconds / 30)
HMAC    = HMAC-SHA1(secret, T as 8-byte big-endian)
offset  = HMAC[19] & 0x0f
code    = ((HMAC[offset] & 0x7f) << 24 | HMAC[offset+1] << 16 | HMAC[offset+2] << 8 | HMAC[offset+3]) mod 10^digits
```

Test vector (RFC 6238 Appendix B, SHA1, ASCII secret `12345678901234567890`): at `T = 59 s` the 8-digit code is `94287082`, so the 6-digit code is `287082`. Every implementation must pass this.

## 4. Verification with replay protection

- Accept a window of ±1 step (previous, current, next) to tolerate clock drift.
- `@oslojs/otp`'s `verifyTOTP` only returns a boolean. To know **which step matched**, compute HOTP for `T-1`, `T`, `T+1` ourselves (`generateHOTP(secret, counter, 6)`) and compare in constant time.
- Store the matched step in `users.totp_last_step`; reject any code whose step is ≤ the stored value. This prevents replaying an intercepted code within its validity window.
- Rate-limit attempts per pending login (5) and per user (see [design/04](../design/04-auth.md)).

## 5. Pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| Codes always wrong | Server clock drift | Check `timedatectl`; NTP. The panel shows server time on the TOTP page |
| Codes wrong only in one app | App ignores non-default parameters | Use defaults (§1) |
| Same code accepted twice | No replay protection | §4 |
| Secret leaks in logs | Logging the provisioning URI | Never log; the secret is stored encrypted (`totp_secret_enc`) |
