# figma-export

figma-export is a CLI tool for bulk exporting Figma, FigJam, and Figma Slides files to your local desktop in Figma's proprietary `.fig`/`.jam`/`.deck` format. figma-export supports downloading by team, project, and even drafts.

This tool leverages [Figma's REST API](https://www.figma.com/developers/api) and [Playwright](https://playwright.dev/) to automate discovering Figma files and downloading them.

> [!NOTE]
> If you are a complete beginner to the terminal and CLI tools, please refer to the [Complete beginner guide](https://github.com/alexchantastic/figma-export/wiki/Complete-beginner-guide) in the wiki.

## Table of contents

- [Requirements](#requirements)
- [Installation](#Installation)
- [Usage](#usage)
- [Commands](#commands)
- [Known issues](#known-issues)

## Requirements

- node (v20 LTS)
- npm (v10 LTS)

Other versions may work, but have not been officially tested.

You will also need a [Figma access token](https://www.figma.com/developers/api#authentication) with scope access to **file content** that you can generate through your Figma user profile settings.

> [!NOTE]
> You must disable opening links in the Figma desktop app in order for downloads to work. See the [Figma docs](https://help.figma.com/hc/articles/360039824334-Open-links-in-the-desktop-app#h_01HW8HDP9DN3HTMQ65XQMXR88A) on how to disable this setting.

## Installation

1. Clone the repository or download the latest release
2. `cd` into the repository
3. Run `npm install`

## Usage

### Environment variables

Create a `.env` file at the root of the repository:

```sh
FIGMA_EMAIL="email@example.com"
FIGMA_PASSWORD="hunter2"
FIGMA_ACCESS_TOKEN="figd_abcdefghijklmnopqrstuvwxyz"
DOWNLOAD_PATH="/Users/anonymous/Downloads" # Absolute path where files will be downloaded to
WAIT_TIMEOUT=10000 # Time in ms to wait between downloads (defaults to 10000)
```

> [!CAUTION]
> Figma has started to implement anti-automation detection which may cause issues with using this tool. It is recommended that you do not set a lower `WAIT_TIMEOUT` than `10000`. To be on the safer side, you may want to increase it even further.

If you are using SSO to log in to Figma, you can either manually set a password (see [wiki](https://github.com/alexchantastic/figma-export/wiki/Manually-setting-a-Figma-password)) _or_ you can provide your Figma auth session cookie through `FIGMA_AUTH_COOKIE` in lieu of `FIGMA_EMAIL` and `FIGMA_PASSWORD`:

```sh
FIGMA_AUTH_COOKIE="my-auth-cookie-value"
FIGMA_ACCESS_TOKEN="figd_abcdefghijklmnopqrstuvwxyz"
DOWNLOAD_PATH="/Users/anonymous/Downloads"
WAIT_TIMEOUT=10000
```

The value for `FIGMA_AUTH_COOKIE` should be the value of the `__Host-figma.authn` cookie. Please refer to the [wiki](https://github.com/alexchantastic/figma-export/wiki/Getting-your-Figma-auth-session-cookie) on how to grab this value.

### Generating files.json

`files.json` determines which Figma files within your account will be downloaded.

> [!TIP]
> Drafts are just a hidden project in Figma so you can absolutely download them with figma-export. Check out the [wiki](https://github.com/alexchantastic/figma-export/wiki/Downloading-draft-files) to learn about how to grab the drafts project ID.

It is recommended that you use one of the built-in commands to generate `files.json`:

- `npm run get-team-files {team_ids ...}` - Gets all files for all projects within given team IDs (space separated)
  - Example: `npm run get-team-files 12345 67890`
- `npm run get-project-files {project_ids ...}` - Gets all files for given project IDs (space separated)
  - Example: `npm run get-project-files 12345 67890`

To find your Figma team ID, navigate to your [Figma home](https://www.figma.com/files/), right click your team in the left sidebar, and then click **Copy link**. The last segment of the URL that you copied will contain your team ID: `https://www.figma.com/files/team/1234567890`.

To find a project ID, navigate to your team's home, right click the project, and then click **Copy link**. The last segment of the URL that you copied will contain the project ID: `https://www.figma.com/files/project/1234567890`.

You are free to manually construct this file as long as it follows this structure:

```json
[
  {
    "name": String,
    "id": String,
    "team_id": String?,
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

Each file will be downloaded to your specified `DOWNLOAD_PATH` in a folder named with the project's name and ID. Each file will be saved as the file's name and ID (key). The folder structure will look something like this:

```
Project A (12345)/
├── File X (123).fig
└── File Y (456).fig
Project B (67890)/
└── File Z (789).fig
```

If you ran `get-team-files`, your `files.json` will also have references to the team ID(s) so projects will be placed in a folder named after the team ID. In which case, the folder structure will look something like this:

```
1029384756/
├── Project A (12345)/
│   ├── File X (123).fig
│   └── File Y (456).fig
└── Project B (67890)/
    └── File Z (789).fig
5647382910/
└── Project C (45678)/
    └── File W (012).fig
```

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

> [!CAUTION]
> It is not advised to use parallel downloads as Figma has started to invoke anti-automation safe guards.

### Retrying failed downloads

If you encounter downloads that fail, you can attempt to re-run _only_ those failed downloads using the `npm run retry` command.

Note that downloads may fail due to any number of reasons, but typically it is due to reaching the Playwright timeout. You can increase this timeout by updating the `timeout` configuration in `playwright.config.ts`.

## Commands

The following commands are available via `npm run`:

| Command             | Description                                     |
| ------------------- | ----------------------------------------------- |
| `get-team-files`    | Generates `files.json` from Figma team ID(s)    |
| `get-project-files` | Generates `files.json` from Figma project ID(s) |
| `start`             | Starts downloads                                |
| `retry`             | Retries failed downloads from last run          |
| `dry-run`           | Lists files that will be downloaded             |
| `report`            | Show an HTML report of the last run             |

At any time, you can press `ctrl+c` to stop a command.

## Known issues

- Two-factor authentication is not supported (suggest temporarily disabling two-factor authentication)
- You must have editor access to a file in order to download it
- Some downloads may take a long time (large file size, slow internet connection, etc.) which can trigger the Playwright timeout and lead to a failed download (suggest increasing the `timeout` in `playwright.config.ts`)
- Figma will invoke anti-automation measures based off of how many files you download (suggest using a `WAIT_TIMEOUT` of at least `10000`)
- If you have the setting for opening links in the Figma desktop app enabled, downloads will not start (suggest [disabling the setting](https://help.figma.com/hc/articles/360039824334-Open-links-in-the-desktop-app#h_01HW8HDP9DN3HTMQ65XQMXR88A))
