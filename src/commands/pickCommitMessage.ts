import { QuickPickItem, window } from "vscode";
import { Repository } from "../repository";
import { Command } from "./command";
import { configuration } from "../helpers/configuration";
import { ISvnLogEntry } from "../common/types";

export class PickCommitMessage extends Command {
  constructor(_svnVersion: string) {
    super("svn.pickCommitMessage", { repository: true });
  }

  public async execute(repository: Repository) {
    let logs: ISvnLogEntry[] = [];
    const user = configuration.get("previousCommitsUser", null);
    if (user) {
      logs = (await repository.log("HEAD", "0", 300))
        .filter(entry => entry.author === user)
        .slice(0, 10);
    } else {
      logs = await repository.log("HEAD", "0", 20);
    }

    if (!logs.length) {
      return;
    }

    const picks: QuickPickItem[] = logs.map(l => {
      return {
        label: l.msg,
        description: `r${l.revision} | ${l.author} | ${new Date(
          l.date
        ).toLocaleString()}`
      };
    });

    const selected = await window.showQuickPick(picks);

    if (selected === undefined) {
      return;
    }

    const msg = selected.label;

    repository.inputBox.value = msg;

    return msg;
  }
}
