## What and why

<!-- What does this change do, and why is it needed? Link the issue: "Closes #123". -->

## How it was tested

<!-- Commands run, environments (distro, Docker/Nginx versions), screenshots for UI changes. -->

## Checklist

- [ ] I have signed the [CLA](https://github.com/codenav-ltd/unpanel/blob/main/CLA.md) (the bot will ask on your first PR)
- [ ] New source files carry the SPDX header; any third-party code is permissively licensed and noted in this PR
- [ ] The PR title is a [Conventional Commit](https://www.conventionalcommits.org/) (`feat(docker): …`, `fix(agent): …`)
- [ ] Tests cover the change (unit, plus integration for new routes or protocol methods)
- [ ] New protocol methods declare `capability`, `risk`, `permission`, `timeoutMs`, and `since`; test vectors updated
- [ ] New routes are covered by the authorization matrix test
- [ ] UI changes handle loading, empty, error, and success states and work in all three themes
- [ ] New UI strings are added to `en.ts`
- [ ] Docs updated in this PR (design doc, module doc, KB, or a new ADR)
- [ ] No secrets in logs, fixtures, or screenshots
- [ ] `CHANGELOG.md` "Unreleased" updated for user-visible changes
