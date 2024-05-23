const fs = require("node:fs");
const { getFiles, getProjects } = require("./lib");

(async () => {
  try {
    const { projects } = await getProjects(process.argv[2]);
    const files = [];
    const promises = [];

    for (const project of projects) {
      const projectId = project.id;
      const projectFiles = getFiles(project.id);

      promises.push(projectFiles);

      const projectFilesData = await projectFiles;

      projectFilesData.id = projectId;

      console.log(projectFilesData);

      files.push(projectFilesData);
    }

    Promise.all(promises).then(() => {
      fs.writeFileSync(__dirname + "/../files.json", JSON.stringify(files));
    });
  } catch (error) {
    throw error;
  }
})();
