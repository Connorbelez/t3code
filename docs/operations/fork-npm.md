# Publishing a fork to npm

The `publish-fork-npm.yml` workflow builds the fork's web client and
CLI for Linux x64/ARM64 and macOS ARM64. It does not build desktop
installers. Intel Macs are not supported by the CLI executable packaging.

## Build and publish

Push changes to `staging` to build that branch. Each push gets a unique
`0.0.45-staging.<run-number>` version and uploads the `fork-npm-packages` artifact.
Push-triggered runs build and verify without publishing. Download that artifact
for the first local publish.

Once the workflow is on the fork's default branch, it can also be dispatched
manually. Select `staging` as the run branch, enter your npm scope and a new
version, and choose a dist-tag such as `latest`. Enable **Publish to npm** only
when npm authentication or trusted publishing is configured.

All packages use your scope: `@connor_beleznay/t3` and `@connor_beleznay/t3-<platform>-<arch>`.
Packages are public. Co-workers run:

```sh
npx @connor_beleznay/t3@latest
```

For the first publish, authenticate with npm locally and publish the three platform
tarballs first, then the launcher tarball, each with `npm publish <tarball> --access public`.
Alternatively, set a granular publishing token as the fork's `NPM_TOKEN` Actions secret
and run the workflow with publishing enabled. Never put the token in source control.

For subsequent releases, configure a GitHub trusted publisher for all four packages:
owner = your GitHub account or organization, repository = your fork's repository name,
workflow = `publish-fork-npm.yml`. Allow direct `npm publish`. Remove the bootstrap token
once trusted publishing is configured. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

The workflow publishes platform tarballs before the launcher. Its dry run checks
packaging, not registry permissions. Each release needs a new version; keep the scope
unchanged so existing installations continue to find updates.

## T3 Connect and updates

The build copies `.env.example` into its isolated checkout before bundling. This embeds
the production relay and public Clerk identifiers, preserving T3 Connect configuration.
Each co-worker still signs into T3 Connect with their own account and needs access to
the environment they want to connect to. npm publishing does not grant that access.

Use the fork's bundled web client to see its UI changes. The official hosted web and
mobile clients still use their shipped code and require compatible server contracts.

To update the fork, run `npx @connor_beleznay/t3@latest` again. `t3 update`, service updates,
and managed SSH installation still use official release downloads. This workflow does
not publish fork GitHub release archives or redirect those download paths.

macOS archives are signed ad hoc. This workflow does not configure Developer ID
signing or notarization.

For manual packaging, set `T3CODE_NPM_SCOPE=@connor_beleznay` and
`T3CODE_NPM_REPOSITORY=https://github.com/Connorbelez/t3code` for both
`scripts/build-npm-platform-packages.ts` and `apps/server/scripts/cli.ts publish`.
Without the scope override, the scripts retain upstream package names.
