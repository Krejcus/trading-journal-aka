const { verifyKey } = require('discord-interactions');
const pk = 'da66c77844b360a65737c8808f2fe5e05d70d1e216b1b75cf9488a08c680d439';
console.log(verifyKey('{"type":1}', 'fake', '123', pk));
