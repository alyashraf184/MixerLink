param(
  [string]$PortPrefix = "MixerLink"
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class MidiListen {
  public delegate void MidiInProc(IntPtr hMidiIn, int wMsg, IntPtr dwInstance, IntPtr dwParam1, IntPtr dwParam2);

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
  public struct MidiInCaps {
    public ushort wMid;
    public ushort wPid;
    public uint vDriverVersion;

    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
    public string szPname;

    public uint dwSupport;
  }

  [DllImport("winmm.dll")]
  private static extern uint midiInGetNumDevs();

  [DllImport("winmm.dll", CharSet = CharSet.Ansi)]
  private static extern uint midiInGetDevCaps(uint deviceId, out MidiInCaps caps, uint capsSize);

  [DllImport("winmm.dll")]
  private static extern uint midiInOpen(out IntPtr handle, uint deviceId, MidiInProc callback, IntPtr instance, uint flags);

  [DllImport("winmm.dll")]
  private static extern uint midiInStart(IntPtr handle);

  [DllImport("winmm.dll")]
  private static extern uint midiInStop(IntPtr handle);

  [DllImport("winmm.dll")]
  private static extern uint midiInClose(IntPtr handle);

  private const int CALLBACK_FUNCTION = 0x00030000;
  private const int MIM_DATA = 0x3C3;
  private static readonly AutoResetEvent QuitEvent = new AutoResetEvent(false);
  private static MidiInProc CallbackDelegate;
  private static IntPtr Handle;

  public static int Run(string portPrefix) {
    uint deviceCount = midiInGetNumDevs();

    for (uint i = 0; i < deviceCount; i++) {
      MidiInCaps caps;
      uint capsResult = midiInGetDevCaps(i, out caps, (uint)Marshal.SizeOf(typeof(MidiInCaps)));
      if (capsResult != 0 || caps.szPname == null || !caps.szPname.StartsWith(portPrefix, StringComparison.OrdinalIgnoreCase)) {
        continue;
      }

      CallbackDelegate = OnMidiIn;
      uint openResult = midiInOpen(out Handle, i, CallbackDelegate, IntPtr.Zero, CALLBACK_FUNCTION);
      if (openResult != 0) {
        Console.Error.WriteLine("midiInOpen failed: " + openResult);
        return 3;
      }

      Console.Error.WriteLine("listening " + caps.szPname);
      Console.Out.Flush();
      midiInStart(Handle);
      Console.CancelKeyPress += delegate(object sender, ConsoleCancelEventArgs args) {
        args.Cancel = true;
        QuitEvent.Set();
      };
      QuitEvent.WaitOne();
      midiInStop(Handle);
      midiInClose(Handle);
      return 0;
    }

    Console.Error.WriteLine("MIDI input port not found: " + portPrefix);
    return 1;
  }

  private static void OnMidiIn(IntPtr hMidiIn, int wMsg, IntPtr dwInstance, IntPtr dwParam1, IntPtr dwParam2) {
    if (wMsg != MIM_DATA) {
      return;
    }

    uint message = unchecked((uint)dwParam1.ToInt64());
    int status = (int)(message & 0xFF);
    int data1 = (int)((message >> 8) & 0xFF);
    int data2 = (int)((message >> 16) & 0xFF);
    Console.WriteLine("{\"status\":" + status + ",\"data1\":" + data1 + ",\"data2\":" + data2 + "}");
    Console.Out.Flush();
  }
}
"@

[Environment]::Exit([MidiListen]::Run($PortPrefix))
