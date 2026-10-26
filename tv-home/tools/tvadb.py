"""Small ADB client for the TV that does not need the shared adb server (pure Python adb_shell,
the same library and key the bridge uses).

Usage (TV_IP=<tv address> [ADB_PORT=5555] .venv/bin/python tv-home/tools/tvadb.py ...):
  tvadb.py ping                     connect and say so (exit 1 if the TV cannot be reached)
  tvadb.py shell "<command>"        run a shell command, print the output
  tvadb.py install <file.apk>       install or update an app
  tvadb.py shot <out.png>           screenshot of the TV
  tvadb.py keys KEY [KEY ...]       press remote keys (e.g. DPAD_DOWN ENTER HOME), 0.4 s apart

ADB_PORT is 5555 unless set: the fixed port of "Network debugging", or of `adb tcpip 5555`.
Any failure prints one plain line and exits non-zero, so the shell scripts can stop on it.
"""
import os
import sys
import time


def fail(msg):
    print("tvadb: " + msg, file=sys.stderr)
    sys.exit(1)


def connect():
    try:
        from adb_shell.adb_device import AdbDeviceTcp
        from adb_shell.auth.sign_pythonrsa import PythonRSASigner
    except ImportError:
        fail("needs adb-shell: .venv/bin/pip install -r bridge/requirements.txt")
    ip = os.environ.get("TV_IP") or fail("set TV_IP to the address of the TV")
    try:
        port = int(os.environ.get("ADB_PORT") or 5555)
    except ValueError:
        fail("ADB_PORT must be a number")
    key = os.path.expanduser(os.environ.get("ADB_KEY", "~/.android/adbkey"))
    if not os.path.exists(key):
        from adb_shell.auth.keygen import keygen
        os.makedirs(os.path.dirname(key), exist_ok=True)
        keygen(key)
    signer = PythonRSASigner(open(key + ".pub").read(), open(key).read())
    dev = AdbDeviceTcp(ip, port, default_transport_timeout_s=60)
    try:
        dev.connect(rsa_keys=[signer], auth_timeout_s=10)
    except Exception as e:
        fail(f"cannot reach the TV at {ip}:{port} over ADB ({type(e).__name__}). Is it on, on this "
             "Wi-Fi, with Network debugging on and this computer allowed? See docs/UNINSTALL.md for "
             "the TV-remote-only way.")
    return dev


def main():
    if len(sys.argv) < 2:
        fail("usage: tvadb.py ping | shell CMD | install APK | shot OUT.png | keys KEY ...")
    cmd, args = sys.argv[1], sys.argv[2:]
    dev = connect()
    try:
        if cmd == "ping":
            print("ok")
        elif cmd == "shell":
            print(dev.shell(args[0], timeout_s=120), end="")
        elif cmd == "install":
            dev.push(args[0], "/data/local/tmp/tvhome.apk")
            out = dev.shell("pm install -r /data/local/tmp/tvhome.apk; rm -f /data/local/tmp/tvhome.apk", timeout_s=180)
            print(out, end="")
            if "Success" not in out:
                fail("the TV did not install the app (see the line above)")
        elif cmd == "shot":
            dev.shell("screencap -p /sdcard/tv-shot.png")
            dev.pull("/sdcard/tv-shot.png", args[0])
            print(args[0])
        elif cmd == "keys":
            for k in args:
                dev.shell(f"input keyevent KEYCODE_{k}")
                time.sleep(0.4)
        else:
            fail(f"unknown command {cmd}")
    except SystemExit:
        raise
    except Exception as e:
        fail(f"the TV stopped answering during '{cmd}' ({type(e).__name__}: {e})")
    finally:
        try:
            dev.close()
        except Exception:
            pass


if __name__ == "__main__":
    main()
