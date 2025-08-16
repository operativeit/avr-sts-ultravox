const fs = require('fs');
const path = require('path');

const fileExists = (filename) => fs.existsSync(path.join(__dirname, filename));

module.exports = { fileExists };

