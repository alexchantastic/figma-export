/* eslint-disable */
const fs = require("node:fs");
const { getFiles, parseArgs, filterFiles } = require("./lib");

const { ids: projectIds, filters } = parseArgs(process.argv.slice(2));

(async () => {
  const allFiles = [];

  for (const projectId of projectIds) {
    try {
      let files = await getFiles(projectId);

      files = filterFiles(files, filters);

      files.id = projectId;

      console.log(files);

      allFiles.push(files);
    } catch (error) {
      throw error;
    }
  }

  fs.writeFileSync(__dirname + "/../files.json", JSON.stringify(allFiles));
})();
