import { Schema, model } from "mongoose";

const userSchema = new Schema(
    {
        _id: {
            type: String,
            required: true,
        },
        username: {
            type: String,
            required: true,
            unique: true,
        },
        email: {
            type: String,
            required: true,
            unique: true,
        },
        globalName: {
            type: String,
            required: false,
        },
        defaultAvatar: {
            type: String,
            required: true,
        },
        avatar: {
            type: String,
            required: false,
        },
        previousAvatars: {
            type: [String],
            default: [],
        },
        dateOfBirth: {
            type: Date,
            required: true,
        },
        password: {
            type: String,
            required: true,
        },
        themes: {
            type: [String],
            ref: "themes",
            default: [],
        },
        settings: {
            currentTheme: {
                type: String,
                ref: "themes",
                default: "ashenDusk",
            },
        },
        createdTimestamp: {
            type: Number,
            required: true,
        },
        createdAt: {
            type: Date,
            required: true,
        },
        updatedTimestamp: {
            type: Number,
            required: true,
        },
        updatedAt: {
            type: Date,
            required: true,
        },
    },
    {
        _id: false,
        id: false,
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
        // Making sure we remove sensitive data from the response
        toJSON: {
            virtuals: true,
            transform: function (_, ret) {
                // This fix is a little hacky, but it works
                delete (ret as Partial<typeof ret>)._id;
                delete (ret as Partial<typeof ret>).__v;
                delete (ret as Partial<typeof ret>).password;
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

userSchema.pre("save", function (next) {
    this.set({
        updatedAt: new Date(),
        updatedTimestamp: Date.now(),
    });

    next();
});

const UserModel = model("users", userSchema);

export { UserModel };
