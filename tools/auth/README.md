# Publisher GitHub OAuth Exchange

`github-oauth-exchange.mjs` is a publisher-operated server example, not a plugin
API, SDK, or service bundled with the desktop app. It exports
`createGithubExchangeServer` for the isolated authentication fixture.

## Run

Use Node.js 22 or newer. Supply these values through the deployment environment
or secret manager, never through committed files or shell history:

- `GITHUB_CLIENT_ID`: the publisher's GitHub OAuth App identifier.
- `GITHUB_CLIENT_SECRET`: the server-only OAuth App secret.
- `PORT`: optional loopback port; defaults to `8787`.

From the repository root:

```sh
node tools/auth/github-oauth-exchange.mjs
```

The example listens on `127.0.0.1` and accepts JSON `POST` requests at
`/oauth/github/exchange`. Expose that endpoint through an HTTPS reverse proxy.
Configure edge request-body, connection, timeout, and rate limits. The example
limits the directly connected IP and does not trust forwarded headers; shared
or multi-instance deployments need an appropriate entry-point rate limiter.
Do not log authorization codes, verifiers, request bodies, secrets, or tokens.

## Desktop Configuration

Configure the desktop build with only the public values
`ENEST_GITHUB_CLIENT_ID` and `ENEST_GITHUB_TOKEN_EXCHANGE_URL`. The latter points
to the HTTPS exchange endpoint. Never include `GITHUB_CLIENT_SECRET` in the
desktop bundle. Rebuild and restart the desktop app after changing its build
configuration. CI variables must be explicitly passed to the build environment.

Register the OAuth App's loopback callback as `http://127.0.0.1/callback`; the
desktop app chooses the callback port at runtime. The exchange example accepts
only the loopback callback path and forwards the PKCE verifier to GitHub.
Running this example or its isolated fixture does not confirm that a real
publisher OAuth App, proxy deployment, or system credential store is configured.
