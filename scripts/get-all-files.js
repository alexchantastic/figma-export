const fs = require("node:fs");
const dotenv = require("dotenv");

dotenv.config();

const params = {
  method: "GET",
  headers: {
    "X-FIGMA-TOKEN": process.env.FIGMA_ACCESS_TOKEN,
  },
};

async function getProjects() {
  try {
    const response = await fetch(
      `https://api.figma.com/v1/teams/${process.argv[2]}/projects`,
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

(async () => {
  try {
    const { projects } = await getProjects();
    const files = [];
    const promises = [];

    for (const project of projects) {
      const projectFiles = getFiles(project.id);

      promises.push(projectFiles);

      console.log(await projectFiles);
      files.push(await projectFiles);
    }

    Promise.all(promises).then(() => {
      fs.writeFileSync(__dirname + "/../files.json", JSON.stringify(files));
    });
  } catch (error) {
    throw error;
  }
})();
