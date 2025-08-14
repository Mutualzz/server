import { model, Schema } from "mongoose";

const themeSchema = new Schema(
    {
        _id: {
            type: String,
            required: true,
        },
        name: {
            type: String,
            required: true,
        },
        description: String,
        type: {
            type: String,
            required: true,
        },
        colors: {
            common: {
                white: String,
                black: String,
            },
            primary: String,
            neutral: String,
            background: String,
            surface: String,
            danger: String,
            warning: String,
            info: String,
            success: String,
        },
        typography: {
            colors: {
                primary: String,
                secondary: String,
                accent: String,
                disabled: String,
            },
        },
        createdBy: {
            type: String,
            ref: "users",
            required: true,
        },
        createdAt: {
            type: Date,
            required: true,
        },
        createdTimestamp: {
            type: Number,
            required: true,
        },
        updatedAt: {
            type: Date,
            required: true,
        },
        updatedTimestamp: {
            type: Number,
            required: true,
        },
    },
    {
        virtuals: {
            id: {
                get: function () {
                    return this._id;
                },
                set: function (v: string) {
                    this._id = v;
                },
            },
        },
        toJSON: {
            virtuals: true,
            transform: function (_, ret) {
                // This fix is a little hacky, but it works
                delete (ret as Partial<typeof ret>)._id;
                delete (ret as Partial<typeof ret>).__v;
                return ret;
            },
        },
        toObject: {
            virtuals: true,
            transform: function (_, ret) {
                delete (ret as Partial<typeof ret>)._id;
                delete (ret as Partial<typeof ret>).__v;
                return ret;
            },
        },
    },
);

themeSchema.pre("save", function (next) {
    this.set({
        updatedAt: new Date(),
        updatedTimestamp: Date.now(),
    });

    next();
});

const ThemeModel = model("themes", themeSchema);
export { ThemeModel };
