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

exports.getProjects = getProjects;
exports.getFiles = getFiles;
