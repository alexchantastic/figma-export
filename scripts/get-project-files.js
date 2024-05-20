const fs = require("node:fs");
const { getFiles } = require("./lib");

(async () => {
  try {
    const files = await getFiles(process.argv[2]);

    console.log("files", files);
    fs.writeFileSync(__dirname + "/../files.json", JSON.stringify([files]));
  } catch (error) {
    throw error;
  }
})();
