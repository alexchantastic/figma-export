/* eslint-disable */
const dotenv = require("dotenv");

dotenv.config();

const params = {
  method: "GET",
  headers: {
    "X-FIGMA-TOKEN": process.env.FIGMA_ACCESS_TOKEN,
  },
};

async function getProjects(teamId) {
  try {
    const response = await fetch(
      `https://api.figma.com/v1/teams/${teamId}/projects`,
      params,
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.err || data.message);
    }

    return data;
  } catch (error) {
    throw error;
  }
}

async function getFiles(projectId) {
  try {
    const response = await fetch(
      `https://api.figma.com/v1/projects/${projectId}/files`,
      params,
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.err || data.message);
    }

    return data;
  } catch (error) {
    throw error;
  }
}

function parseArgs(argv) {
  const ids = [];
  const filters = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-last-modified-before") {
      const value = argv[++i];
      if (!value || isNaN(Date.parse(value))) {
        throw new Error(
          `Invalid or missing value for -last-modified-before: ${value}`,
        );
      }
      filters.before = new Date(value);
    } else if (arg === "-last-modified-after") {
      const value = argv[++i];
      if (!value || isNaN(Date.parse(value))) {
        throw new Error(
          `Invalid or missing value for -last-modified-after: ${value}`,
        );
      }
      filters.after = new Date(value);
    } else if (!arg.startsWith("-")) {
      ids.push(arg);
    }
  }

  return { ids, filters };
}

function filterFiles(filesData, filters) {
  if (!filters.before && !filters.after) {
    return filesData;
  }

  if (!filesData.files || !Array.isArray(filesData.files)) {
    return filesData;
  }

  filesData.files = filesData.files.filter((file) => {
    const lastModified = new Date(file.last_modified);
    if (filters.before && lastModified >= filters.before) {
      return false;
    }
    if (filters.after && lastModified <= filters.after) {
      return false;
    }
    return true;
  });

  return filesData;
}

exports.getProjects = getProjects;
exports.getFiles = getFiles;
exports.parseArgs = parseArgs;
exports.filterFiles = filterFiles;
