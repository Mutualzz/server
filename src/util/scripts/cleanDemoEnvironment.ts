import "dotenv/config";

import { closeDatabase, startDatabase } from "@mutualzz/database";
import {
  assertDemoScriptSafeToRun,
  wipeDemoData,
} from "./demoEnvironmentShared";

async function main() {
  assertDemoScriptSafeToRun("clean");

  console.log("Connecting to database...");
  await startDatabase();

  console.log("Removing demo users and related data...");
  const removedUsers = await wipeDemoData();

  if (removedUsers.length === 0) {
    console.log("No demo data found.");
    return;
  }

  console.log(`\nRemoved ${removedUsers.length} demo user(s):\n`);
  for (const user of removedUsers) {
    console.log(`  - ${user.username} (${user.email})`);
  }

  console.log(
    "\nAlso removed their spaces, posts, friendships, DMs, and messages.",
  );
}

main()
  .catch((error) => {
    console.error("Demo cleanup failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase();
  });
