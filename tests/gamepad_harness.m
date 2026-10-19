/* gamepad_harness.m -- checks runtime/gamepad.m against GameController.framework
 * without a physical controller.
 *
 * Software controllers (+[GCController controllerWithExtendedGamepad]) are
 * snapshots: their element values can be set, but they never fire
 * valueChangedHandler.  So the values are set before the controller
 * "connects" (posting GCControllerDidConnectNotification ourselves), and the
 * snapshot that pick_active() queues on the handler queue reads them.  That
 * covers the element -> PadState mapping, the dead zones, the takeover
 * order and the late-snapshot case; live value changes from a real pad are
 * not covered.
 *
 *   clang -fobjc-arc -Iruntime -o out/gamepad_harness tests/gamepad_harness.m \
 *         runtime/gamepad.m -framework Foundation -framework GameController
 *   out/gamepad_harness          # exit status 0 when every check passes */
#import <Foundation/Foundation.h>
#import <GameController/GameController.h>
#include <math.h>
#include <stdio.h>
#include <unistd.h>
#include "gamepad.h"

static int g_fail;
static void pump(double s){ [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:s]]; }
static void check(const char *what, int ok){
    printf("  %s  %s\n", ok ? "PASS" : "FAIL", what);
    if (!ok) g_fail++;
}
static int near(float a, float b){ return fabsf(a - b) < 0.002f; }
static void post(NSString *nm, GCController *k){
    [[NSNotificationCenter defaultCenter] postNotificationName:nm object:k];
}

int main(void){
    @autoreleasepool {
        PadState s;
        gamepad_init(); pump(0.2);

        printf("mapping and dead zones\n");
        GCController *a = [GCController controllerWithExtendedGamepad];
        GCExtendedGamepad *g = a.extendedGamepad;
        [g.buttonA setValue:1]; [g.buttonMenu setValue:1]; [g.buttonOptions setValue:1];
        [g.rightShoulder setValue:1]; [g.leftThumbstickButton setValue:1];
        [g.dpad setValueForXAxis:-1 yAxis:1];                      /* up-left */
        [g.leftThumbstick setValueForXAxis:0.5f yAxis:0.25f];       /* GC: +y up */
        [g.rightThumbstick setValueForXAxis:-1 yAxis:-1];
        [g.leftTrigger setValue:0.01f]; [g.rightTrigger setValue:0.75f];
        post(GCControllerDidConnectNotification, a); pump(0.2);
        gamepad_read(&s);
        uint32_t want = 1u << PAD_A | 1u << PAD_START | 1u << PAD_BACK | 1u << PAD_RB |
                        1u << PAD_LS | 1u << PAD_DUP | 1u << PAD_DLEFT;
        check("connected", s.connected == 1);
        check("buttons A Menu Options RB LS, D-pad up+left", s.buttons == want);
        /* radial dead zone 0.08: |(0.5, 0.25)| = 0.559 -> 0.521, direction kept;
         * y flipped to DirectInput's +down */
        check("left stick (0.5, 0.25 up) -> (0.466, -0.233)",
              near(s.axis[PAD_AXIS_LX], 0.466f) && near(s.axis[PAD_AXIS_LY], -0.233f));
        check("right stick past the rim clamps to the unit circle",
              near(s.axis[PAD_AXIS_RX], -0.707f) && near(s.axis[PAD_AXIS_RY], 0.707f));
        check("left trigger 0.01 inside its dead zone", s.axis[PAD_AXIS_LT] == 0.f);
        check("right trigger 0.75 -> 0.745", near(s.axis[PAD_AXIS_RT], 0.745f));

        printf("takeover\n");
        GCController *b = [GCController controllerWithExtendedGamepad];
        [b.extendedGamepad.buttonB setValue:1];
        post(GCControllerDidConnectNotification, b); pump(0.2);
        gamepad_read(&s);
        check("second controller does not take over", s.buttons == want);
        post(GCControllerDidDisconnectNotification, a); pump(0.2);
        gamepad_read(&s);
        check("first one gone: the second drives the pad", s.connected && s.buttons == 1u << PAD_B);
        post(GCControllerDidDisconnectNotification, b); pump(0.2);
        gamepad_read(&s);
        check("last one gone: not connected, at rest", !s.connected && !s.buttons &&
              s.axis[PAD_AXIS_RT] == 0.f && s.axis[PAD_AXIS_LX] == 0.f);

        printf("late snapshot\n");
        /* C connects and goes away while its first snapshot is still queued
         * behind a blocked handler queue: it must not land in the pad */
        GCController *c = [GCController controllerWithExtendedGamepad];
        [c.extendedGamepad.buttonX setValue:1]; [c.extendedGamepad.rightTrigger setValue:1];
        dispatch_async(a.handlerQueue, ^{ usleep(300000); });
        post(GCControllerDidConnectNotification, c); pump(0.05);
        post(GCControllerDidDisconnectNotification, c); pump(0.6);
        gamepad_read(&s);
        check("queue drained: still at rest", !s.connected && !s.buttons && s.axis[PAD_AXIS_RT] == 0.f);
    }
    printf("%s\n", g_fail ? "FAILED" : "all passed");
    return g_fail ? 1 : 0;
}
