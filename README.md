# figma-export

figma-export is a CLI tool for bulk exporting Figma files to your local desktop in Figma's proprietary `.fig` format.

This tool leverages [Figma's REST API](https://www.figma.com/developers/api) and [Playwright](https://playwright.dev/) to automate discovering Figma files and downloading them.

## Table of contents

- [Requirements](#requirements)
- [Installation](#Installation)
- [Usage](#usage)
- [Caveats](#caveats)

## Requirements

- node (v18.17.x)
- npm (v9.6.x)

Other versions may work, but have not been officially tested.

You will also need a [Figma access token](https://www.figma.com/developers/api#authentication) that you can generate through your Figma user profile settings.

## Installation

1. Clone the repository or download the latest release
2. `cd` into the repository
3. Run `npm install`

## Usage

### Environment variables

Create a `.env` file at the root of the repository:

```sh
FIGMA_EMAIL=email@example.com
FIGMA_PASSWORD=hunter2
FIGMA_TEAM_ID=1234567890
FIGMA_ACCESS_TOKEN=figd_abcdefghijklmnopqrstuvwxyz
DOWNLOAD_PATH="/Users/anonymous/Downloads/" # Absolute path where files will be downloaded to
WAIT_TIMEOUT=10000 # Time in ms to wait between downloads
```

### Generating files.json

`files.json` determines which Figma files within your account will be downloaded.

It is recommended that you use one of the built-in commands to generate `files.json`:

- `npm run get-all-files {team_id}` - Gets all files within a team
- `npm run get-project-files {project_id}` - Gets all files for a given project ID

To find your Figma team ID, navigate to your [Figma home](https://www.figma.com/files/), right click your team in the left sidebar, and then click **Copy link**. The last segment of the URL that you copied will contain your team ID: `https://www.figma.com/files/team/1234567890`.

To find a project ID, navigate to your team's home, right click the project, and then click **Copy link**. The last segment of the URL that you copied will contain the project ID: `https://www.figma.com/files/project/1234567890`.

You are free to manually construct this file as long as it follows this structure:

```json
[
  {
    "name": String
    "files": [
      {
        "key": String,
        "name": String
      },
      ...
    ]
  },
  ...
]
```

This is a modified structure from the return value of [Figma's GET project files](https://www.figma.com/developers/api#get-project-files-endpoint) endpoint.

### Starting the downloads

Once you have generated `files.json`, you can then run `npm run start` to start the downloads. The status of each download will be shown in the console.

Each file will be downloaded to your specified `DOWNLOAD_PATH` in a folder with the project's name.

### Parallel downloads

Parallel downloads are disabled by default. To enable them, update the following properties in `playwright.config.ts`:

```ts
export default defineConfig({
  ...
  fullyParallel: true,
  workers: 3, // The maximum number of parallel downloads
  ...
});
```

## Caveats

- SSO authentication is not supported
- Two-factor authentication is not supported
- Rate limiting may occur as it is not clear if Figma will throttle based off of how many files you download (suggest using `WAIT_TIMEOUT`)
- Files with the same name in the same project are not supported
