package nro;

import javax.microedition.lcdui.Canvas;
import javax.microedition.lcdui.Display;
import main.GameCanvas;
import main.GameMidlet;

public abstract class MotherCanvas extends Canvas implements Runnable {
   public static volatile boolean isCanvasThreadRunning;
   public static volatile boolean renderEnabled = true;
   public static volatile int repaintIntervalMillis = 27;

   public static void showGameCanvas(GameMidlet gameMidlet) {
      Display.getDisplay(gameMidlet).setCurrent(GameCanvas.instance);
   }

   public MotherCanvas() {
      this.setFullScreenMode(true);
      int imageWidth = super.getWidth();
      int imageHeight = super.getHeight();
      int imageWidth2 = imageWidth;
      if (imageWidth * imageHeight >= 2073600) {
         mGraphics.zoomLevel = 4;
      } else if (imageWidth2 * imageHeight >= 691200) {
         mGraphics.zoomLevel = 3;
      } else if (imageWidth2 * imageHeight > 153600) {
         mGraphics.zoomLevel = 2;
      } else {
         mGraphics.zoomLevel = 1;
      }

      while (mGraphics.zoomLevel > 1) {
         java.io.InputStream fontResource = this.getClass().getResourceAsStream("/x" + mGraphics.zoomLevel + "/myfont/tahoma_8b.png");
         if (fontResource == null) {
            mGraphics.zoomLevel--;
         } else {
            try {
               fontResource.close();
            } catch (java.io.IOException ignoredIOException) {
            }
            break;
         }
      }
   }

   public final synchronized void startCanvasThread() {
      if (isCanvasThreadRunning) return;
      isCanvasThreadRunning = true;
      new Thread(this).start();
   }

   public static String getPlatformName() {
      return System.getProperty("microedition.platform");
   }

   public int getHeight() {
      return super.getHeight();
   }

   public int getWidth() {
      return super.getWidth();
   }

   public final int getWidthz() {
      int imageWidth;
      return (imageWidth = super.getWidth()) / mGraphics.zoomLevel + (imageWidth % mGraphics.zoomLevel == 0 ? 0 : 1);
   }

   public final int getHeightz() {
      int imageHeight;
      return (imageHeight = super.getHeight()) / mGraphics.zoomLevel + (imageHeight % mGraphics.zoomLevel == 0 ? 0 : 1);
   }

   protected final void pointerDragged(int value, int value2) {
      value /= mGraphics.zoomLevel;
      value2 /= mGraphics.zoomLevel;
      this.onPointerDragged(value, value2);
   }

   protected final void pointerPressed(int value, int value2) {
      value /= mGraphics.zoomLevel;
      value2 /= mGraphics.zoomLevel;
      this.onPointerPressed(value, value2);
   }

   protected final void pointerReleased(int value, int value2) {
      value /= mGraphics.zoomLevel;
      value2 /= mGraphics.zoomLevel;
      this.onPointerReleased(value, value2);
   }

   protected abstract void onPointerDragged(int value, int value2);

   protected abstract void onPointerPressed(int value, int value2);

   protected abstract void onPointerReleased(int value, int value2);

   protected abstract void update();

   public void run() {
      try {
         Thread.sleep(100L);
      } catch (Exception ignoredException) {
      }

      long lastRepaint = 0L;
      while (isCanvasThreadRunning) {
         long nowMillis = System.currentTimeMillis();
         this.update();
         if (renderEnabled && nowMillis - lastRepaint >= repaintIntervalMillis) {
            this.repaint();
            this.serviceRepaints();
            lastRepaint = nowMillis;
         }
         long elapsedMillis = System.currentTimeMillis() - nowMillis;

         try {
            Thread.sleep(elapsedMillis < 27L ? 27L - elapsedMillis : 1L);
         } catch (InterruptedException interrupted) {
            return;
         }
      }
   }
}
