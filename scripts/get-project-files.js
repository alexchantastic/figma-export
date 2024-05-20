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
    return data;
  } catch (error) {
    console.error(error);
  }
}

getFiles().then((files) => {
  console.log(files);

  fs.writeFileSync(__dirname + "/../files.json", JSON.stringify([files]));
});
