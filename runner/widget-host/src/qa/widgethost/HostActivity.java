package qa.widgethost;

import android.app.Activity;
import android.appwidget.AppWidgetHost;
import android.appwidget.AppWidgetHostView;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProviderInfo;
import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.Process;
import android.util.Log;
import android.util.SizeF;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.RemoteViews;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

/**
 * Binds every home-screen widget of one app (extra "pkg"; "only" = comma-separated widget names, a name being the
 * provider class without its package and "Provider") and lays them out like a 4-column launcher page: a widget of
 * targetCellWidth x targetCellHeight cells gets that many cells of the screen. Extra "page" scrolls to that screenful.
 * Logs (tag QaWidgetHost) "pages N", "bound NAME ...", "update NAME" when the app sent its views and "error NAME" when
 * they failed to inflate. Binding needs `adb shell appwidget grantbind --package qa.widgethost --user 0` first.
 */
public class HostActivity extends Activity {
  static final String TAG = "QaWidgetHost";
  static final int HOST_ID = 4711;
  static final int COLUMNS = 4;

  AppWidgetHost host;

  class LoggingView extends AppWidgetHostView {
    final String name;
    LoggingView(Context c, String name) { super(c); this.name = name; }
    @Override public void updateAppWidget(RemoteViews views) {
      super.updateAppWidget(views);
      if (views != null) Log.i(TAG, "update " + name);
    }
    @Override protected View getErrorView() {
      Log.w(TAG, "error " + name);
      return super.getErrorView();
    }
  }

  class Host extends AppWidgetHost {
    String nextName = "?";
    Host(Context c) { super(c, HOST_ID); }
    @Override protected AppWidgetHostView onCreateView(Context c, int id, AppWidgetProviderInfo info) {
      return new LoggingView(c, nextName);
    }
  }

  int dp(float v) { return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics())); }

  static String nameOf(AppWidgetProviderInfo info) {
    String cls = info.provider.getClassName();
    String n = cls.substring(cls.lastIndexOf('.') + 1);
    return n.endsWith("Provider") ? n.substring(0, n.length() - "Provider".length()) : n;
  }

  @Override protected void onCreate(Bundle state) {
    super.onCreate(state);
    Intent in = getIntent();
    String pkg = in.getStringExtra("pkg");
    String only = in.getStringExtra("only");
    int page = in.getIntExtra("page", 0);
    boolean night = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;

    AppWidgetManager mgr = AppWidgetManager.getInstance(this);
    Host h = new Host(this);
    host = h;
    // A fresh bind on every start: the provider renders again for the current light/dark setting and size.
    h.deleteHost();
    h.startListening();

    List<AppWidgetProviderInfo> infos = new ArrayList<>();
    if (pkg != null) {
      for (AppWidgetProviderInfo info : mgr.getInstalledProvidersForPackage(pkg, Process.myUserHandle())) {
        if (only == null || only.isEmpty() || ("," + only + ",").contains("," + nameOf(info) + ",")) infos.add(info);
      }
    }
    if (only != null && !only.isEmpty()) { // the order of "only"
      List<AppWidgetProviderInfo> sorted = new ArrayList<>();
      for (String n : only.split(",")) for (AppWidgetProviderInfo i : infos) if (nameOf(i).equals(n)) sorted.add(i);
      infos = sorted;
    }
    Log.i(TAG, "providers " + infos.size() + " night " + night);

    float density = getResources().getDisplayMetrics().density;
    float screenW = getResources().getDisplayMetrics().widthPixels / density;
    final float screenH = getResources().getDisplayMetrics().heightPixels / density;
    float margin = 12, gap = 8;
    float cellW = (screenW - 2 * margin) / COLUMNS;
    float cellH = cellW * 1.25f;

    FrameLayout root = new FrameLayout(this);
    // A flat mid-tone "wallpaper", so the widget's own edges and corners show.
    root.setBackgroundColor(night ? Color.parseColor("#1B2530") : Color.parseColor("#6E8FAF"));
    final ScrollView scroll = new ScrollView(this);
    scroll.setFillViewport(true);
    final LinearLayout col = new LinearLayout(this);
    col.setOrientation(LinearLayout.VERTICAL);
    col.setPadding(dp(margin), dp(48), dp(margin), dp(48));
    scroll.addView(col);
    root.addView(scroll);

    LinearLayout row = null;
    int used = COLUMNS;
    for (AppWidgetProviderInfo info : infos) {
      String name = nameOf(info);
      int cw = 0, ch = 0;
      if (Build.VERSION.SDK_INT >= 31) { cw = info.targetCellWidth; ch = info.targetCellHeight; }
      if (cw <= 0) cw = Math.max(1, (int) Math.ceil((info.minWidth / density + 16) / 73f));
      if (ch <= 0) ch = Math.max(1, (int) Math.ceil((info.minHeight / density + 16) / 73f));
      cw = Math.min(cw, COLUMNS);
      float wDp = cw * cellW - gap, hDp = ch * cellH - gap;

      int id = h.allocateAppWidgetId();
      Bundle opts = new Bundle();
      opts.putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, (int) wDp);
      opts.putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, (int) wDp);
      opts.putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, (int) hDp);
      opts.putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, (int) hDp);
      if (Build.VERSION.SDK_INT >= 31) {
        ArrayList<SizeF> sizes = new ArrayList<>();
        sizes.add(new SizeF(wDp, hDp));
        opts.putParcelableArrayList(AppWidgetManager.OPTION_APPWIDGET_SIZES, sizes);
      }
      boolean ok = mgr.bindAppWidgetIdIfAllowed(id, Process.myUserHandle(), info.provider, opts);
      Log.i(TAG, (ok ? "bound " : "bind-refused ") + name + " " + cw + "x" + ch + " " + Math.round(wDp) + "x" + Math.round(hDp) + "dp");
      if (!ok) continue;

      h.nextName = name;
      AppWidgetHostView view = h.createView(this, id, info);
      view.setPadding(0, 0, 0, 0);
      LinearLayout cell = new LinearLayout(this);
      cell.setOrientation(LinearLayout.VERTICAL);
      cell.addView(view, new LinearLayout.LayoutParams(dp(wDp), dp(hDp)));
      TextView label = new TextView(this);
      label.setText(name + " " + cw + "×" + ch);
      label.setTextColor(Color.WHITE);
      label.setTextSize(11);
      label.setShadowLayer(3, 0, 1, Color.BLACK);
      label.setGravity(Gravity.CENTER_HORIZONTAL);
      cell.addView(label, new LinearLayout.LayoutParams(dp(wDp), ViewGroup.LayoutParams.WRAP_CONTENT));

      if (row == null || used + cw > COLUMNS) {
        row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams rp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        rp.bottomMargin = dp(gap * 2);
        col.addView(row, rp);
        used = 0;
      }
      LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
      lp.rightMargin = dp(gap);
      row.addView(cell, lp);
      used += cw;
    }
    setContentView(root);

    final int wanted = page;
    scroll.post(new Runnable() {
      @Override public void run() {
        // Pages: consecutive rows that fit one screen; page N starts at its first row.
        List<Integer> starts = new ArrayList<>();
        int pageTop = 0;
        int limit = dp(screenH) - dp(96);
        starts.add(0);
        for (int i = 0; i < col.getChildCount(); i++) {
          View r = col.getChildAt(i);
          if (r.getBottom() - pageTop > limit && r.getTop() > pageTop) { pageTop = Math.max(0, r.getTop() - dp(24)); starts.add(pageTop); }
        }
        Log.i(TAG, "pages " + starts.size());
        scroll.scrollTo(0, starts.get(Math.min(wanted, starts.size() - 1)));
      }
    });
  }

  @Override protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    recreate();
  }

  @Override protected void onDestroy() {
    if (host != null) host.stopListening();
    super.onDestroy();
  }
}
