// Tiny X11 helper for the desktop end-to-end tests: real input (XTest) and a real window close (WM_DELETE_WINDOW,
// what the title bar's X button sends) on the test's own nested X display (Xephyr), never on the user's screen.
// Build: cc -O2 -o xinput xinput.c -lX11 -lXtst      Usage: DISPLAY=:N ./xinput <cmd> ...
//   wins                      top-level windows: "<id> <pid> <x> <y> <w> <h> <name>"
//   close <win>               ask the window to close (like clicking X)
//   focus <win>               give the window the keyboard (there is no window manager to do it)
//   move <x> <y> | click <x> <y> [button] [count] | down <button> | up <button>
//   key <keysym> [ctrl|shift|alt ...]   e.g. key space, key Right, key k ctrl, key Escape
#include <X11/Xlib.h>
#include <X11/Xatom.h>
#include <X11/Xutil.h>
#include <X11/keysym.h>
#include <X11/extensions/XTest.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static long pid_of(Display *d, Window w) {
  Atom a = XInternAtom(d, "_NET_WM_PID", True), t; int f; unsigned long n, r; unsigned char *p = NULL; long pid = -1;
  if (a != None && XGetWindowProperty(d, w, a, 0, 1, False, XA_CARDINAL, &t, &f, &n, &r, &p) == Success && p) { if (n) pid = *(long *)p; XFree(p); }
  return pid;
}
static void list(Display *d, Window w, int depth) {
  Window root, parent, *kids; unsigned int n;
  if (!XQueryTree(d, w, &root, &parent, &kids, &n)) return;
  for (unsigned int i = 0; i < n; i++) {
    XWindowAttributes at; char *name = NULL;
    if (XGetWindowAttributes(d, kids[i], &at) && at.map_state == IsViewable) {
      XFetchName(d, kids[i], &name);
      long pid = pid_of(d, kids[i]);
      if (name || pid > 0) { int x, y; Window c; XTranslateCoordinates(d, kids[i], root, 0, 0, &x, &y, &c);
        printf("0x%lx %ld %d %d %d %d %s\n", kids[i], pid, x, y, at.width, at.height, name ? name : ""); }
      if (name) XFree(name);
    }
    if (depth < 3) list(d, kids[i], depth + 1);
  }
  if (kids) XFree(kids);
}
// A modifier left "down" (e.g. Alt from a key press that reached the nested display from the desktop) would turn every
// later key into Alt+key, which the app rightly ignores: release them all before any input.
static void clearmods(Display *d) {
  const KeySym m[] = { XK_Shift_L, XK_Shift_R, XK_Control_L, XK_Control_R, XK_Alt_L, XK_Alt_R, XK_Super_L, XK_Super_R, XK_Meta_L, XK_Meta_R, XK_ISO_Level3_Shift };
  for (unsigned i = 0; i < sizeof m / sizeof *m; i++) { KeyCode k = XKeysymToKeycode(d, m[i]); if (k) XTestFakeKeyEvent(d, k, False, 0); }
}
int main(int argc, char **argv) {
  if (argc < 2) return 2;
  Display *d = XOpenDisplay(NULL);
  if (!d) { fprintf(stderr, "no display\n"); return 1; }
  const char *c = argv[1];
  if (strcmp(c, "wins")) clearmods(d);
  if (!strcmp(c, "wins")) list(d, DefaultRootWindow(d), 0);
  else if (!strcmp(c, "close") && argc > 2) {
    Window w = strtoul(argv[2], NULL, 0); XEvent e = {0};
    e.xclient.type = ClientMessage; e.xclient.window = w; e.xclient.message_type = XInternAtom(d, "WM_PROTOCOLS", False);
    e.xclient.format = 32; e.xclient.data.l[0] = XInternAtom(d, "WM_DELETE_WINDOW", False); e.xclient.data.l[1] = CurrentTime;
    XSendEvent(d, w, False, NoEventMask, &e);
  } else if (!strcmp(c, "focus") && argc > 2) { Window w = strtoul(argv[2], NULL, 0); XRaiseWindow(d, w); XSetInputFocus(d, w, RevertToPointerRoot, CurrentTime); }
  else if (!strcmp(c, "move") && argc > 3) XTestFakeMotionEvent(d, -1, atoi(argv[2]), atoi(argv[3]), 0);
  else if (!strcmp(c, "click") && argc > 3) {
    int b = argc > 4 ? atoi(argv[4]) : 1, n = argc > 5 ? atoi(argv[5]) : 1;
    XTestFakeMotionEvent(d, -1, atoi(argv[2]), atoi(argv[3]), 0); XFlush(d); usleep(30000);
    for (int i = 0; i < n; i++) { XTestFakeButtonEvent(d, b, True, 0); XFlush(d); usleep(20000); XTestFakeButtonEvent(d, b, False, 0); XFlush(d); usleep(40000); }
  } else if ((!strcmp(c, "down") || !strcmp(c, "up")) && argc > 2) XTestFakeButtonEvent(d, atoi(argv[2]), !strcmp(c, "down"), 0);
  else if (!strcmp(c, "key") && argc > 2) {
    KeyCode mods[4]; int m = 0;
    for (int i = 3; i < argc && m < 4; i++) {
      KeySym s = !strcmp(argv[i], "ctrl") ? XK_Control_L : !strcmp(argv[i], "shift") ? XK_Shift_L : XK_Alt_L;
      mods[m] = XKeysymToKeycode(d, s); XTestFakeKeyEvent(d, mods[m++], True, 0);
    }
    KeyCode k = XKeysymToKeycode(d, XStringToKeysym(argv[2]));
    if (!k) { fprintf(stderr, "unknown key %s\n", argv[2]); return 1; }
    XTestFakeKeyEvent(d, k, True, 0); XFlush(d); usleep(30000); XTestFakeKeyEvent(d, k, False, 0);
    while (m--) XTestFakeKeyEvent(d, mods[m], False, 0);
  } else { fprintf(stderr, "bad command\n"); return 2; }
  XFlush(d); XCloseDisplay(d); return 0;
}
