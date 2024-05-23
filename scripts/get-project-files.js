const fs = require("node:fs");
const { getFiles } = require("./lib");

const projectId = process.argv[2];

(async () => {
  try {
    const files = await getFiles(projectId);

    files.id = projectId;

    console.log("files", files);

    fs.writeFileSync(__dirname + "/../files.json", JSON.stringify([files]));
  } catch (error) {
    throw error;
  }
})();
