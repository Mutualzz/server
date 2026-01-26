import {
    SlashCommandAttachmentOption,
    SlashCommandBooleanOption,
    SlashCommandChannelOption,
    SlashCommandIntegerOption,
    SlashCommandMentionableOption,
    SlashCommandNumberOption,
    SlashCommandRoleOption,
    SlashCommandStringOption,
    SlashCommandUserOption,
    type MessageActionRowComponentBuilder,
    type ModalActionRowComponentBuilder,
} from "@discordjs/builders";
import {
    ActionRowBuilder,
    AttachmentBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelSelectMenuBuilder,
    EmbedBuilder,
    isJSONEncodable,
    MentionableSelectMenuBuilder,
    ModalBuilder,
    RoleSelectMenuBuilder,
    StringSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle,
    UserSelectMenuBuilder,
    type ActionRowComponentData,
    type ActionRowData,
    type APIActionRowComponent,
    type APIButtonComponent,
    type APIChannelSelectComponent,
    type APIComponentInActionRow,
    type APIComponentInMessageActionRow,
    type APIComponentInModalActionRow,
    type APIEmbed,
    type APIMentionableSelectComponent,
    type APIModalInteractionResponseCallbackData,
    type APIRoleSelectComponent,
    type APIStringSelectComponent,
    type APITextInputComponent,
    type APIUserSelectComponent,
    type AttachmentData,
    type BufferResolvable,
    type ButtonComponentData,
    type ChannelSelectMenuComponentData,
    type EmbedData,
    type JSONEncodable,
    type MentionableSelectMenuComponentData,
    type ModalComponentData,
    type RoleSelectMenuComponentData,
    type StringSelectMenuComponentData,
    type TextInputComponentData,
    type UserSelectMenuComponentData,
} from "discord.js";
import type { Stream } from "stream";

export class Row extends ActionRowBuilder<MessageActionRowComponentBuilder> {
    constructor(
        data?: Partial<
            | ActionRowData<
                  | ActionRowComponentData
                  | JSONEncodable<APIComponentInActionRow>
              >
            | APIActionRowComponent<
                  APIComponentInMessageActionRow | APIComponentInModalActionRow
              >
        >,
    ) {
        super(data);
    }
}

export class ModalRow extends ActionRowBuilder<ModalActionRowComponentBuilder> {
    constructor(
        data?: Partial<
            | ActionRowData<
                  | ActionRowComponentData
                  | JSONEncodable<APIComponentInActionRow>
              >
            | APIActionRowComponent<
                  APIComponentInMessageActionRow | APIComponentInModalActionRow
              >
        >,
    ) {
        super(data);
    }
}

export class Attachment extends AttachmentBuilder {
    constructor(attachment: BufferResolvable | Stream, data?: AttachmentData) {
        super(attachment, data);
    }
}

export class Embed extends EmbedBuilder {
    constructor(data?: EmbedData | APIEmbed) {
        super(data);
        this.setColor("#f99753");
        this.setTimestamp();
    }
}

export class Button extends ButtonBuilder {
    constructor(
        data?: Partial<ButtonComponentData> | Partial<APIButtonComponent>,
        defaultStyle = true,
    ) {
        super(data);
        if (defaultStyle) this.setStyle(ButtonStyle.Secondary);
    }

    static from(
        other: JSONEncodable<APIButtonComponent> | APIButtonComponent,
        defaultStyle = true,
    ) {
        return new this(
            isJSONEncodable(other) ? other.toJSON() : other,
            defaultStyle,
        );
    }
}

export class StringDropdown extends StringSelectMenuBuilder {
    constructor(
        data?: Partial<
            StringSelectMenuComponentData | APIStringSelectComponent
        >,
    ) {
        super(data);
    }
}

export class UserDropdown extends UserSelectMenuBuilder {
    constructor(
        data?: Partial<UserSelectMenuComponentData | APIUserSelectComponent>,
    ) {
        super(data);
    }
}

export class RoleMenu extends RoleSelectMenuBuilder {
    constructor(
        data?: Partial<RoleSelectMenuComponentData | APIRoleSelectComponent>,
    ) {
        super(data);
    }
}

export class ChannelDropdown extends ChannelSelectMenuBuilder {
    constructor(
        data?: Partial<
            ChannelSelectMenuComponentData | APIChannelSelectComponent
        >,
    ) {
        super(data);
    }
}

export class MentionableDropdown extends MentionableSelectMenuBuilder {
    constructor(
        data?: Partial<
            MentionableSelectMenuComponentData | APIMentionableSelectComponent
        >,
    ) {
        super(data);
    }
}

export class Modal extends ModalBuilder {
    constructor(
        data?:
            | Partial<ModalComponentData>
            | Partial<APIModalInteractionResponseCallbackData>,
    ) {
        super(data);
    }
}

export class TextInput extends TextInputBuilder {
    constructor(
        style: "short" | "long" = "short",
        data?: Partial<TextInputComponentData | APITextInputComponent>,
    ) {
        super(data);
        this.setStyle(
            style === "short" ? TextInputStyle.Short : TextInputStyle.Paragraph,
        );
        this.setRequired(true);
    }
}

export class StringOption extends SlashCommandStringOption {
    constructor() {
        super();
        this.setRequired(true);
    }
}

export class AttachmentOption extends SlashCommandAttachmentOption {
    constructor() {
        super();
        this.setRequired(true);
    }
}

export class UserOption extends SlashCommandUserOption {
    constructor() {
        super();
        this.setRequired(true);
    }
}

export class RoleOption extends SlashCommandRoleOption {
    constructor() {
        super();
        this.setRequired(true);
    }
}

export class ChannelOption extends SlashCommandChannelOption {
    constructor() {
        super();
        this.setRequired(true);
    }
}

export class BooleanOption extends SlashCommandBooleanOption {
    constructor() {
        super();
        this.setRequired(true);
    }
}

export class IntegerOption extends SlashCommandIntegerOption {
    constructor() {
        super();
        this.setRequired(true);
    }
}

export class MentionableOption extends SlashCommandMentionableOption {
    constructor() {
        super();
        this.setRequired(true);
    }
}

export class NumberOption extends SlashCommandNumberOption {
    constructor() {
        super();
        this.setRequired(true);
    }
}
