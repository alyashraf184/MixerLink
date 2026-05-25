using System;
using System.Globalization;
using System.Runtime.InteropServices;

public static class MidiSend {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
  public struct MidiOutCaps {
    public ushort wMid;
    public ushort wPid;
    public uint vDriverVersion;

    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
    public string szPname;

    public ushort wTechnology;
    public ushort wVoices;
    public ushort wNotes;
    public ushort wChannelMask;
    public uint dwSupport;
  }

  [DllImport("winmm.dll")]
  private static extern uint midiOutGetNumDevs();

  [DllImport("winmm.dll", CharSet = CharSet.Ansi)]
  private static extern uint midiOutGetDevCaps(uint deviceId, out MidiOutCaps caps, uint capsSize);

  [DllImport("winmm.dll")]
  private static extern uint midiOutOpen(out IntPtr handle, uint deviceId, IntPtr callback, IntPtr instance, uint flags);

  [DllImport("winmm.dll")]
  private static extern uint midiOutShortMsg(IntPtr handle, uint message);

  [DllImport("winmm.dll")]
  private static extern uint midiOutClose(IntPtr handle);

  public static int Main(string[] args) {
    if (args.Length < 2) {
      Console.Error.WriteLine("Usage: midi-send.exe <port-prefix> <message> [message...]");
      return 2;
    }

    string portPrefix = args[0];
    uint deviceCount = midiOutGetNumDevs();

    for (uint i = 0; i < deviceCount; i++) {
      MidiOutCaps caps;
      uint capsResult = midiOutGetDevCaps(i, out caps, (uint)Marshal.SizeOf(typeof(MidiOutCaps)));
      if (capsResult != 0 || caps.szPname == null || !caps.szPname.StartsWith(portPrefix, StringComparison.OrdinalIgnoreCase)) {
        continue;
      }

      IntPtr handle;
      uint openResult = midiOutOpen(out handle, i, IntPtr.Zero, IntPtr.Zero, 0);
      if (openResult != 0) {
        Console.Error.WriteLine("midiOutOpen failed: " + openResult);
        return 3;
      }

      try {
        for (int messageIndex = 1; messageIndex < args.Length; messageIndex++) {
          uint message = ParseMessage(args[messageIndex]);
          uint sendResult = midiOutShortMsg(handle, message);
          if (sendResult != 0) {
            Console.Error.WriteLine("midiOutShortMsg failed: " + sendResult);
            return 4;
          }
        }
      } finally {
        midiOutClose(handle);
      }

      Console.WriteLine("sent " + (args.Length - 1) + " message(s) to " + caps.szPname);
      return 0;
    }

    Console.Error.WriteLine("MIDI output port not found: " + portPrefix);
    return 1;
  }

  private static uint ParseMessage(string value) {
    if (value.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) {
      return uint.Parse(value.Substring(2), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
    }

    return uint.Parse(value, CultureInfo.InvariantCulture);
  }
}
