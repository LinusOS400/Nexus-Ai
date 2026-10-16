# First-time GitHub update setup

The app is configured to check the public releases for `LinusOS400/Nexus-Ai`. The repository currently needs the Nexus Studio source and workflow before it can build its first release.

## One-time setup

1. Download and extract the `nexus-studio-source-0.4.4.zip` source archive.
2. Open [LinusOS400/Nexus-Ai](https://github.com/LinusOS400/Nexus-Ai) in GitHub Desktop (clone it first if needed).
3. Copy the extracted project files and folders—including the hidden `.github/workflows` directory—into the cloned repository folder. The archive intentionally excludes `node_modules`, build output, and old release binaries.
4. Review the license before replacing the repository's existing `LICENSE`: the GitHub repository currently says Apache-2.0, while this source project's package metadata says MIT. Keep the chosen license consistent.
5. Commit and push the source files to the `main` branch.
6. Open the repository's **Actions** tab, select **Publish Windows updater release**, then choose **Run workflow**. The workflow runs typecheck/tests, builds the NSIS installer on Windows, and publishes the installer, `latest.yml`, and blockmap to a GitHub Release. It uses the repository's built-in `GITHUB_TOKEN`; do not add a personal access token.
7. Download and install `Nexus-Studio-Setup-0.4.4-x64.exe` from the release. From then on, use **Settings → Updates** to check, download, and install future versions from within Nexus.

## Later releases

Update the version in `package.json` and `package-lock.json` together, commit/push the change, then either push the matching tag (for example, `v0.4.5`) or run the workflow manually. The workflow publishes the corresponding installer and update metadata.

The updater is for the installed Windows NSIS build. Portable builds are intentionally not self-updating. Builds are currently unsigned; Windows SmartScreen may display a warning.
