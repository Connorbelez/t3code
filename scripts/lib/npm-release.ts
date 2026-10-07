import serverPackageJson from "../../apps/server/package.json" with { type: "json" };

export const NPM_PLATFORM_PACKAGE_SCOPE = process.env.T3CODE_NPM_SCOPE?.trim() || "@t3code";
export const NPM_LAUNCHER_PACKAGE_NAME = process.env.T3CODE_NPM_SCOPE?.trim()
  ? `${NPM_PLATFORM_PACKAGE_SCOPE}/t3`
  : "t3";
export const NPM_REPOSITORY = {
  ...serverPackageJson.repository,
  url: process.env.T3CODE_NPM_REPOSITORY?.trim() || serverPackageJson.repository.url,
};
