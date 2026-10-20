// Usage: npm run hash-password -- 'your password'
// Put the printed line into the ADMIN_PASSWORD_HASH environment variable.
import { hashPassword } from "../web/auth.js";

const password = process.argv[2];
if (!password) {
  console.error("用法：npm run hash-password -- '你的密码'");
  process.exit(2);
}
console.log(hashPassword(password));
