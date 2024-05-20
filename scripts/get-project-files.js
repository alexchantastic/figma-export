const fs = require("node:fs");
const dotenv = require("dotenv");

dotenv.config();

async function getFiles() {
  try {
    const response = await fetch(
      `https://api.figma.com/v1/projects/${process.argv[2]}/files`,
      {
        method: "GET",
        headers: {
          "X-FIGMA-TOKEN": process.env.FIGMA_ACCESS_TOKEN,
        },
      },
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
    const files = await getFiles();

    console.log("files", files);
    fs.writeFileSync(__dirname + "/../files.json", JSON.stringify([files]));
  } catch (error) {
    throw error;
  }
})();
