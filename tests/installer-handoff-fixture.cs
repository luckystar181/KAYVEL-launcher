using System;
using System.IO;
using KayvelSetup;

internal static class InstallerHandoffFixture
{
    private static int Main(string[] args)
    {
        string root = Environment.GetEnvironmentVariable("KAYVEL_HANDOFF_FIXTURE_ROOT");
        try
        {
            File.WriteAllText(Path.Combine(root, "started.txt"), "fixture entered");
            using (var handoff = UpdateHandoff.FromArguments(args))
            {
                if (handoff == null) throw new IOException("Missing fixture handoff");
                handoff.Complete(1500).GetAwaiter().GetResult();
                File.WriteAllText(Path.Combine(root, "completed.txt"), "parent exited; no launcher executed");
            }
            return 0;
        }
        catch (Exception error)
        {
            File.WriteAllText(Path.Combine(root, "rejected.txt"), error.ToString());
            return 1;
        }
    }
}
