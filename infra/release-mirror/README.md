# Release mirror

Release packages are served from `https://unpanel.codenav.dev/releases/<version>/<file>`, an R2 bucket behind a small Worker. GitHub releases stay the canonical source and the fallback: `channels.json` still lists GitHub URLs, and every client derives the mirror URL from them, tries it first, and checks the published SHA-256 whichever copy it used.

Every installed version already trusts `unpanel.codenav.dev` as a release host, which is why the mirror lives on this hostname instead of its own subdomain.

| Client | Mirror first since |
|---|---|
| `install.sh`, `install-agent.sh` | the next release |
| `unpanel-manage update` | after the install has that release |
| Settings → Updates, remote agent updates | after the panel or agent has that release |

## One-time setup

1. Create the R2 bucket `unpanel-releases` (Cloudflare dashboard → R2).
2. Deploy the Worker from this directory: `npx wrangler@4.144.0 deploy`. It routes `unpanel.codenav.dev/releases/*` and binds the bucket as `RELEASES`. The route answers before the site's origin, so `/releases/` paths that are not in the bucket return 404 instead of the site page.
3. Create an API token with **Workers R2 Storage: Edit** for the account. In the GitHub repository, add it as the secret `CLOUDFLARE_API_TOKEN` and the account ID as the variable `CLOUDFLARE_ACCOUNT_ID`. `RELEASE_BUCKET` overrides the bucket name.
4. Mirror the current release once:

   ```bash
   gh release download v0.1.0-alpha.41 --dir /tmp/mirror
   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… bash scripts/upload-mirror.sh 0.1.0-alpha.41 /tmp/mirror
   ```

From then on the Release workflow uploads each tag after publishing it and checks the public URLs against `SHA256SUMS`. Without the token it logs a warning and the release continues on GitHub alone.
