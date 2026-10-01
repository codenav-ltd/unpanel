# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Design documentation: overview, architecture, agent protocol, node lifecycle, authentication, security, data model, HTTP API, frontend, deployment, testing.
- Module designs for monitoring, alerting, notifications, Docker, PM2, Nginx, systemd services, certificates, terminal and files, firewall, cron, probes, and backups.
- Architecture Decision Records 0001–0011.
- Trademark policy and Contributor License Agreement (drafts).

### Changed

- License changed from MIT to AGPL-3.0-or-later before any code was published ([ADR-0011](./docs/adr/0011-agpl-license.md)).
- Project named **Unpanel**; binaries, paths, systemd units, and environment variables use the `unpanel` prefix.
- Maintenance knowledge base for external systems, conventions, release process, troubleshooting, and runbooks.
- Repository community files: README, contributing guide, security policy, code of conduct, issue and pull request templates.
