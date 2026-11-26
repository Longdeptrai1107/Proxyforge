import java.awt.Frame;
import java.io.*;
import java.lang.management.ManagementFactory;
import java.lang.reflect.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import javax.swing.SwingUtilities;
import org.microemu.app.Main;

/** Checks real game scheduling, idle sender wakeups, minimized rendering and heap budget. */
public final class RuntimeResourceTest {
    static void check(boolean ok, String message) { if (!ok) throw new AssertionError(message); }
    static void await(BooleanSupplier condition, String message) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
        while (!condition.getAsBoolean() && System.nanoTime() < deadline) Thread.sleep(10);
        check(condition.getAsBoolean(), message);
    }
    static int countCanvasThreads() {
        int count = 0;
        for (StackTraceElement[] trace : Thread.getAllStackTraces().values())
            for (StackTraceElement entry : trace) if (entry.getClassName().equals("nro.MotherCanvas") && entry.getMethodName().equals("run")) { count++; break; }
        return count;
    }
    public static void main(String[] args) throws Exception {
        Path data = NroAccountManager.dataDirectory().resolve("tests").resolve("resources-" + UUID.randomUUID());
        Path runtime = NroAccountManager.prepareRuntime(data), profile = data.resolve("profile"); Files.createDirectories(profile);
        try (GameFlowTestServer peer = new GameFlowTestServer(false)) {
            StringWriter payload = new StringWriter();
            payload.write(Base64.getEncoder().encodeToString("resource-test@example.invalid".getBytes(StandardCharsets.UTF_8)) + "\n");
            payload.write(Base64.getEncoder().encodeToString("Resource Test 123".getBytes(StandardCharsets.UTF_8)) + "\n0\nresource-test\n");
            qltk.net.ProxyConfig.DIRECT.writeTo(payload);
            System.setIn(new ByteArrayInputStream(payload.toString().getBytes(StandardCharsets.UTF_8)));
            EmulatorBootstrap.main(new String[] {runtime.toString(), profile.toString(), "--flow-test=" + peer.listener.getLocalPort() + ",cached"});
            peer.login.get(25, TimeUnit.SECONDS);
            Field commonField = Main.class.getDeclaredField("common"); commonField.setAccessible(true);
            Frame frame = Arrays.stream(Frame.getFrames()).filter(f -> f instanceof Main).findFirst().orElseThrow();
            org.microemu.app.Common common = (org.microemu.app.Common)commonField.get(frame);
            ClassLoader loader = common.getLauncher().getCurrentMIDlet().getClass().getClassLoader();
            Class<?> canvasClass = loader.loadClass("main.GameCanvas"), mother = loader.loadClass("nro.MotherCanvas");
            Object canvas = canvasClass.getField("instance").get(null);
            check(countCanvasThreads() == 1, "Expected one canvas update thread");
            mother.getMethod("startCanvasThread").invoke(canvas);
            check(countCanvasThreads() == 1, "Starting canvas twice created another update loop");

            Class<?> sessionClass = loader.loadClass("nro.Session_ME"); Object session = sessionClass.getMethod("gI").invoke(null);
            Thread sender = (Thread)sessionClass.getField("senderThread").get(session);
            await(() -> sender.getState() == Thread.State.WAITING, "Idle sender is polling instead of waiting");
            Class<?> messageClass = loader.loadClass("nro.Message");
            sessionClass.getMethod("sendMessage", messageClass).invoke(session, messageClass.getConstructor(byte.class).newInstance((byte)99));
            await(() -> peer.commands.contains(99), "Enqueue did not wake the idle sender");
            await(() -> sender.getState() == Thread.State.WAITING, "Sender did not return to waiting");
            sessionClass.getMethod("close").invoke(session); sender.join(2000);
            check(!sender.isAlive(), "Closing the session left a waiting sender behind");

            Field enabled = mother.getField("renderEnabled"), interval = mother.getField("repaintIntervalMillis"), tick = canvasClass.getField("gameTick");
            SwingUtilities.invokeAndWait(() -> frame.setExtendedState(Frame.ICONIFIED));
            await(() -> { try { return !enabled.getBoolean(null); } catch (Exception e) { throw new RuntimeException(e); } }, "Minimizing did not disable rendering");
            int firstTick = tick.getInt(null);
            com.sun.management.OperatingSystemMXBean os = (com.sun.management.OperatingSystemMXBean)ManagementFactory.getOperatingSystemMXBean();
            long firstCpu = os.getProcessCpuTime(), firstTime = System.nanoTime();
            // A timed observation window measures update progress and CPU, not a startup delay.
            new java.util.concurrent.CountDownLatch(1).await(2, TimeUnit.SECONDS);
            int ticks = tick.getInt(null) - firstTick; if (ticks < 0) ticks += 10001;
            long elapsed = System.nanoTime() - firstTime, cpu = os.getProcessCpuTime() - firstCpu;
            check(ticks >= 10, "Minimizing paused game updates/network scheduling");
            SwingUtilities.invokeAndWait(() -> { frame.setExtendedState(Frame.NORMAL); frame.toFront(); });
            await(() -> { try { return enabled.getBoolean(null); } catch (Exception e) { throw new RuntimeException(e); } }, "Restoring did not resume rendering");
            SwingUtilities.invokeAndWait(() -> {
                try { check(interval.getInt(null) == (frame.isActive() ? 27 : 200), "Focus policy interval differs"); }
                catch (IllegalAccessException e) { throw new RuntimeException(e); }
            });
            java.lang.management.MemoryUsage heap = ManagementFactory.getMemoryMXBean().getHeapMemoryUsage();
            check(heap.getMax() <= 96L * 1024 * 1024, "Resource test did not use the 96 MB heap budget");
            String report = String.format(Locale.ROOT,
                "{\n  \"passed\": true,\n  \"heap_max_bytes\": %d,\n  \"heap_used_bytes\": %d,\n  \"minimized_observation_ms\": %.1f,\n  \"minimized_cpu_ms\": %.1f,\n  \"update_ticks_while_minimized\": %d,\n  \"idle_sender_waits_and_wakes\": true,\n  \"single_canvas_thread\": true\n}\n",
                heap.getMax(), heap.getUsed(), elapsed / 1e6, cpu / 1e6, ticks);
            if (args.length > 0) Files.writeString(Path.of(args[0]), report, StandardCharsets.UTF_8);
            System.out.println("RESOURCE PASS: idle sender waits/wakes/stops; one canvas loop; minimized rendering stops while " + ticks
                + " update ticks continue; restoring resumes rendering; heap used " + heap.getUsed() / 1048576 + " MiB of " + heap.getMax() / 1048576 + " MiB");
        } finally { SwingUtilities.invokeAndWait(() -> { for (Frame frame : Frame.getFrames()) frame.dispose(); }); }
        System.exit(0);
    }
}
