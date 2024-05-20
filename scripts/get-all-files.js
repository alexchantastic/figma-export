const fs = require("node:fs");
const { getFiles, getProjects } = require("./lib");

(async () => {
  try {
    const { projects } = await getProjects(process.argv[2]);
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
