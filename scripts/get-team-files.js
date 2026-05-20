/* eslint-disable */
const fs = require("node:fs");
const { getFiles, getProjects, parseArgs, filterFiles } = require("./lib");

const { ids: teamIds, filters } = parseArgs(process.argv.slice(2));

(async () => {
  const allFiles = [];
  const promises = [];

  for (const teamId of teamIds) {
    try {
      const { projects } = await getProjects(teamId);

      for (const project of projects) {
        const projectId = project.id;
        const projectFiles = getFiles(project.id).then((data) =>
          filterFiles(data, filters),
        );

        promises.push(projectFiles);

        const projectFilesData = await projectFiles;

        projectFilesData.id = projectId;
        projectFilesData.team_id = teamId;

        console.log(projectFilesData);

        allFiles.push(projectFilesData);
      }
    } catch (error) {
      throw error;
    }
  }

  Promise.all(promises).then(() => {
    fs.writeFileSync(__dirname + "/../files.json", JSON.stringify(allFiles));
  });
})();
