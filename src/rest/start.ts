import { dbConnection, startDatabase } from "@mutualzz/database*";
import { Server } from "./Server";

if (!dbConnection) startDatabase();

const server = new Server();
server.start();
