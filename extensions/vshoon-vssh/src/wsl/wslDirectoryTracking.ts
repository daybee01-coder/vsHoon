/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Starts the WSL user's configured shell with a small prompt hook that reports its current directory
 * through VS Code's standard OSC 633 protocol. The hook is installed after the user's normal
 * shell configuration so custom prompts keep working.
 */
export const WSL_DIRECTORY_TRACKING_LAUNCHER = String.raw`set -u
shell_path="$(getent passwd "$(id -un)" 2>/dev/null | awk -F: 'NR == 1 { print $7 }')"
if [ -z "$shell_path" ] || [ ! -x "$shell_path" ]; then
	shell_path="\${SHELL:-/bin/sh}"
fi

case "\${shell_path##*/}" in
	bash)
		rc_file="$(mktemp "\${TMPDIR:-/tmp}/vshoon-bashrc.XXXXXX")" || exec "$shell_path" -i
		cat >"$rc_file" <<'VSHOON_BASH_RC'
if [[ -r "$HOME/.bashrc" ]]; then
	source "$HOME/.bashrc"
fi
__vshoon_emit_cwd() {
	local value="\${PWD//\\/\\x5c}"
	value="\${value//;/\\x3b}"
	builtin printf '\033]633;P;Cwd=%s\007' "$value"
	builtin printf '\033]633;P;HasRichCommandDetection=False\007'
}
if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
	PROMPT_COMMAND+=(__vshoon_emit_cwd)
else
	PROMPT_COMMAND="__vshoon_emit_cwd\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
fi
rm -f -- "$VSHOON_TRACKING_RC"
unset VSHOON_TRACKING_RC
VSHOON_BASH_RC
		VSHOON_TRACKING_RC="$rc_file" exec "$shell_path" --rcfile "$rc_file" -i
		;;
	zsh)
		rc_dir="$(mktemp -d "\${TMPDIR:-/tmp}/vshoon-zshrc.XXXXXX")" || exec "$shell_path" -i
		cat >"$rc_dir/.zshrc" <<'VSHOON_ZSH_RC'
if [[ -r "$VSHOON_ORIGINAL_ZDOTDIR/.zshrc" ]]; then
	source "$VSHOON_ORIGINAL_ZDOTDIR/.zshrc"
fi
__vshoon_emit_cwd() {
	local value="\${PWD//\\/\\x5c}"
	value="\${value//;/\\x3b}"
	builtin printf '\033]633;P;Cwd=%s\007' "$value"
	builtin printf '\033]633;P;HasRichCommandDetection=False\007'
}
autoload -Uz add-zsh-hook
add-zsh-hook precmd __vshoon_emit_cwd
ZDOTDIR="$VSHOON_ORIGINAL_ZDOTDIR"
export ZDOTDIR
rm -rf -- "$VSHOON_TRACKING_RC"
unset VSHOON_TRACKING_RC VSHOON_ORIGINAL_ZDOTDIR
VSHOON_ZSH_RC
		original_zdotdir="\${ZDOTDIR:-$HOME}"
		VSHOON_TRACKING_RC="$rc_dir" VSHOON_ORIGINAL_ZDOTDIR="$original_zdotdir" ZDOTDIR="$rc_dir" exec "$shell_path" -i
		;;
	fish)
		rc_file="$(mktemp "\${TMPDIR:-/tmp}/vshoon-fishrc.XXXXXX")" || exec "$shell_path" -i
		cat >"$rc_file" <<'VSHOON_FISH_RC'
function __vshoon_emit_cwd --on-event fish_prompt
	set -l value (string replace -a '\\' '\\x5c' -- "$PWD")
	set value (string replace -a ';' '\\x3b' -- "$value")
	printf '\e]633;P;Cwd=%s\a' "$value"
	printf '\e]633;P;HasRichCommandDetection=False\a'
end
rm -f -- "$VSHOON_TRACKING_RC"
set -e VSHOON_TRACKING_RC
VSHOON_FISH_RC
		VSHOON_TRACKING_RC="$rc_file" exec "$shell_path" -C "source '$rc_file'" -i
		;;
	*)
		exec "$shell_path" -i
		;;
esac`.replaceAll('\\${', '${');

export function wslTerminalShellArgs(distro?: string): string[] {
	const distroArgs = distro ? ['-d', distro] : [];
	return [...distroArgs, '--cd', '/', '--exec', 'sh', '-c', WSL_DIRECTORY_TRACKING_LAUNCHER];
}
