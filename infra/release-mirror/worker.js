// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 CodeNav Ltd and contributors

// Serves /releases/<version>/<file> from the R2 bucket. Release files never
// change once published, so they may be cached for a year; anything else is
// a plain 404 rather than the site's index page, so installers fall back to GitHub.
const RELEASE_PATH = /^\/releases\/([0-9A-Za-z.-]+)\/([A-Za-z0-9._-]+)$/;

// eslint-disable-next-line local/no-default-export -- Workers load the module's default export.
export default {
  async fetch(request, env) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed\n", { status: 405, headers: { allow: "GET, HEAD" } });
    }
    const match = new URL(request.url).pathname.match(RELEASE_PATH);
    if (!match) return notFound();
    const key = `releases/${match[1]}/${match[2]}`;
    const object =
      request.method === "HEAD" ? await env.RELEASES.head(key) : await env.RELEASES.get(key);
    if (!object) return notFound();
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("content-length", String(object.size));
    headers.set("cache-control", "public, max-age=31536000, immutable");
    return new Response(request.method === "HEAD" ? null : object.body, { headers });
  },
};

function notFound() {
  return new Response("Not found\n", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
