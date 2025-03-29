const fs = require("node:fs");
var todayDate = new Date().toISOString().slice(0, 10);
const data = JSON.parse(fs.readFileSync("files.json", { encoding: "utf-8" }),);

const filterFilesByYear = (data, year) => {
    return data.map(group => ({
        ...group,
        files: group.files.filter(file => file.last_modified.includes(year))
    })).filter(group => group.files.length > 0); 
};

const result = filterFilesByYear(data, todayDate);


 fs.writeFileSync(todayDate + ".json", JSON.stringify(result, null, 2));
