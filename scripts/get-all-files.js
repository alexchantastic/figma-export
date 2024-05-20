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
    return data;
  } catch (error) {
    console.error(error);
  }
}

async function getFiles(projectId) {
  try {
    const response = await fetch(
      `https://api.figma.com/v1/projects/${projectId}/files`,
      params,
    );

    const data = await response.json();
    return data;
  } catch (error) {
    console.error(error);
  }
}

getProjects().then((data) => {
  const { projects } = data;
  const files = [];
  const promises = [];

  for (const project of projects) {
    promises.push(
      getFiles(project.id).then((d) => {
        console.log(d);

        files.push(d);
      }),
    );
  }

  Promise.all(promises).then(() => {
    fs.writeFileSync(__dirname + "/../files.json", JSON.stringify(files));
  });
});
