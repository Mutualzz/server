import { model, Schema } from "mongoose";

const spaceSchema = new Schema(
    {
        _id: {
            type: String,
            required: true,
        },
        name: {
            type: String,
            required: true,
        },
        ownerId: {
            type: String,
            required: true,
        },
        description: {
            type: String,
            default: null,
        },
        icon: {
            type: String,
            default: null,
        },
        createdAt: {
            type: Date,
            required: true,
        },
        createdTimestamp: {
            type: Number,
            required: true,
        },
        updatedAt: Date,
        updatedTimestamp: Number,
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

spaceSchema.pre("save", function (next) {
    this.set({
        updatedAt: new Date(),
        updatedTimestamp: Date.now(),
    });

    next();
});

const SpaceModel = model("spaces", spaceSchema);
export { SpaceModel };
