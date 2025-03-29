/* eslint-disable */
const fs = require("node:fs");
const { getFiles } = require("./lib");

const projectIds = process.argv.slice(2);

(async () => {
  const allFiles = [];

  for (const projectId of projectIds) {
    try {
      const files = await getFiles(projectId);

      files.id = projectId;

      console.log(files);

      allFiles.push(files);
    } catch (error) {
      throw error;
    }
  }

  fs.writeFileSync(__dirname + "/../files.json", JSON.stringify(allFiles));
})();
