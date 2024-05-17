const fs = require("node:fs");
const dotenv = require("dotenv");

dotenv.config();

async function getData() {
  try {
    const response = await fetch(
      `https://api.figma.com/v1/projects/${process.env.PROJECT_ID}/files`,
      {
        method: "GET",
        headers: {
          "X-FIGMA-TOKEN": process.env.FIGMA_API_KEY,
        },
      },
    );

    const data = await response.json();
    return data;
  } catch (error) {
    console.error(error);
  }
}

getData().then((data) => {
  console.log(data);

  fs.writeFileSync(__dirname + "/../files.json", JSON.stringify(data));
});
