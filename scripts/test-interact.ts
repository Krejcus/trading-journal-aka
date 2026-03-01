import { verifyKey } from 'discord-interactions';
try {
  console.log(verifyKey('{"type":1}', 'fake', '123', 'da66c77844b360a65737c8808f2fe5e05d70d1e216b1b75cf9488a08c680d439'));
} catch (e) {
  console.log('Error thrown:', e);
}
