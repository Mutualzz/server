import { Listener } from "@sapphire/framework";
import { container } from "@sapphire/pieces";

export default class RestDebugEvent extends Listener {
    constructor(context: Listener.LoaderContext, options: Listener.Options) {
        super(context, {
            ...options,
            event: "restDebug",
            name: "rest-debug",
            description:
                "Event that triggers when a REST debug message is received",
            emitter: container.client.rest,
        });
    }

    run(debug: string) {
        container.logger.debug(debug);
    }
}
