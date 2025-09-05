import amqplib, { type Channel, type ChannelModel } from "amqplib";
import { logger } from "./Logger";
export class RabbitMQ {
    static connection: ChannelModel;
    static channel: Channel;

    static async init() {
        this.connection = await amqplib.connect(
            {
                hostname: "localhost",
                username: process.env.RABBIT_USERNAME,
                password: process.env.RABBIT_PASSWORD,
            },
            {
                timeout: 10000,
            },
        );
        logger.info("[RabbitMQ] Connected to RabbitMQ");
        this.channel = await this.connection.createChannel();
        logger.info("[RabbitMQ] Channel created");
    }
}
