import { getCtx, lastAssistantMessageId } from './context.js';
import { cancelJob, enqueue, getJobState } from './pipeline.js';
import { countForSettings, getSettings } from './settings.js';

function toBool(value) {
    if (value === true || value === false) {
        return value;
    }
    return String(value ?? '').toLowerCase() === 'true';
}

function toast(kind, message) {
    const fn = window.toastr?.[kind];
    if (typeof fn === 'function') {
        fn.call(window.toastr, message, 'Storybook');
    }
}

export function registerCommands() {
    const ctx = getCtx();
    const parser = ctx.SlashCommandParser;
    if (!parser?.commands || !ctx.SlashCommand) {
        return;
    }
    if (parser.commands.storybook) {
        return;
    }

    const { SlashCommandNamedArgument, ARGUMENT_TYPE } = ctx;

    parser.addCommandObject(ctx.SlashCommand.fromProps({
        name: 'storybook',
        returns: 'Status of the storybook request',
        helpString: 'Generate the keyframe storybook for a message. /storybook [force=true] [count=3] [cancel=true]',
        namedArgumentList: [
            new SlashCommandNamedArgument('force', 'Regenerate even if a finished storybook already exists', [ARGUMENT_TYPE.BOOLEAN], false, false, 'false'),
            new SlashCommandNamedArgument('count', 'Number of keyframes for this run (1-6)', [ARGUMENT_TYPE.NUMBER], false, false, '0'),
            new SlashCommandNamedArgument('cancel', 'Stop any running storybook generation', [ARGUMENT_TYPE.BOOLEAN], false, false, 'false'),
        ],
        unnamedArgumentList: [],
        callback: async (args) => {
            if (toBool(args?.cancel)) {
                cancelJob(null);
                return 'Storybook generation cancelled.';
            }

            const context = getCtx();
            const mesId = lastAssistantMessageId();
            const message = mesId >= 0 ? context.chat[mesId] : null;

            if (!message) {
                toast('warning', 'There is no reply to illustrate yet.');
                return 'No message to illustrate.';
            }

            const requested = Number(args?.count);
            const count = Number.isFinite(requested) && requested > 0
                ? Math.min(6, Math.round(requested))
                : countForSettings(getSettings());

            const started = enqueue(mesId, { force: toBool(args?.force), count, reason: 'command' });
            if (!started) {
                const state = getJobState();
                if (state.mesId === mesId && state.state !== 'idle') {
                    return 'A storybook is already being generated for this message.';
                }
                toast('info', 'A finished storybook is already on this message. Use force=true to regenerate.');
                return 'Storybook already present.';
            }

            toast('info', `Generating a ${count}-frame storybook...`);
            return `Storybook generation started with ${count} keyframes.`;
        },
    }));
}
