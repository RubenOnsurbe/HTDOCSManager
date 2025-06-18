import os
import shutil
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
import json

APP_NAME = "gestor-xampp"
CONFIG_FILE = "config.json"

def get_appdata_dir():
    return os.path.join(os.environ["APPDATA"], APP_NAME)

def ensure_appdata_dir():
    path = get_appdata_dir()
    os.makedirs(path, exist_ok=True)
    return path

def load_config():
    config_path = os.path.join(get_appdata_dir(), CONFIG_FILE)
    if os.path.exists(config_path):
        with open(config_path, "r") as f:
            return json.load(f)
    else:
        return {"wamp_path": "", "projects": [], "active_project": ""}

def save_config(config):
    config_path = os.path.join(get_appdata_dir(), CONFIG_FILE)
    with open(config_path, "w") as f:
        json.dump(config, f, indent=4)

class DeployApp:
    def __init__(self, root):
        self.root = root
        self.root.title("Gestor de XAMPP/WAMP")
        self.root.geometry("600x450")
        self.root.configure(bg="#f2f2f2")  # Fondo claro estilo Microsoft

        self.set_style()

        ensure_appdata_dir()
        self.config = load_config()

        self.wamp_dir = tk.StringVar(value=self.config.get("wamp_path", ""))
        self.project_dirs = self.config.get("projects", [])
        self.active_project = tk.StringVar(value=self.config.get("active_project", ""))

        self.create_widgets()
        self.refresh_project_listbox()

    def set_style(self):
        # Cambiar fuente a Segoe UI y personalizar colores (azul Microsoft)
        self.root.option_add("*Font", "SegoeUI 10")
        style = ttk.Style()
        style.theme_use("clam")
        style.configure("TButton",
                        background="#0078D7",
                        foreground="white",
                        padding=6,
                        relief="flat")
        style.map("TButton",
                  background=[("active", "#005A9E")])
        style.configure("TLabel",
                        background="#f2f2f2",
                        foreground="#333333")
        style.configure("TEntry",
                        padding=5)
        style.configure("TListbox",
                        padding=5)

    def create_widgets(self):
        frame = ttk.Frame(self.root, padding=10)
        frame.pack(fill=tk.BOTH, expand=True)

        # WAMP/XAMPP directory
        ttk.Label(frame, text="Ruta WAMP/XAMPP:").grid(row=0, column=0, sticky="w", padx=5, pady=5)
        wamp_entry = ttk.Entry(frame, textvariable=self.wamp_dir, width=50)
        wamp_entry.grid(row=0, column=1, padx=5, pady=5)
        ttk.Button(frame, text="Seleccionar", command=self.select_wamp_dir).grid(row=0, column=2, padx=5, pady=5)

        # Projects
        ttk.Label(frame, text="Proyectos:").grid(row=1, column=0, sticky="w", padx=5, pady=5)
        self.project_listbox = tk.Listbox(frame, width=75, height=10, selectbackground="#0078D7", activestyle="dotbox")
        self.project_listbox.grid(row=2, column=0, columnspan=3, padx=5, pady=5)
        self.project_listbox.bind("<<ListboxSelect>>", self.set_active_project)

        # Buttons
        ttk.Button(frame, text="Añadir Proyecto", command=self.add_project).grid(row=3, column=0, padx=5, pady=5)
        ttk.Button(frame, text="Eliminar Proyecto", command=self.remove_project).grid(row=3, column=1, padx=5, pady=5)
        ttk.Button(frame, text="Mandar a Directorio", command=self.deploy_project).grid(row=4, column=0, columnspan=3, padx=5, pady=10)

    def select_wamp_dir(self):
        directory = filedialog.askdirectory(title="Seleccionar directorio de WAMP/XAMPP")
        if directory:
            self.wamp_dir.set(directory)
            self.config["wamp_path"] = directory
            save_config(self.config)

    def add_project(self):
        directory = filedialog.askdirectory(title="Seleccionar carpeta del proyecto")
        if directory and directory not in self.project_dirs:
            self.project_dirs.append(directory)
            self.config["projects"] = self.project_dirs
            save_config(self.config)
            self.refresh_project_listbox()

    def remove_project(self):
        selected = self.project_listbox.curselection()
        if selected:
            index = selected[0]
            project_to_remove = self.project_dirs[index]
            if self.active_project.get() == project_to_remove:
                self.active_project.set("")
                self.config["active_project"] = ""
            del self.project_dirs[index]
            self.config["projects"] = self.project_dirs
            save_config(self.config)
            self.refresh_project_listbox()

    def refresh_project_listbox(self):
        self.project_listbox.delete(0, tk.END)
        for project in self.project_dirs:
            label = project
            if project == self.active_project.get():
                label += " [ACTIVO]"
            self.project_listbox.insert(tk.END, label)

    def set_active_project(self, event):
        selection = self.project_listbox.curselection()
        if selection:
            index = selection[0]
            project = self.project_dirs[index]
            self.active_project.set(project)
            self.config["active_project"] = project
            save_config(self.config)
            self.refresh_project_listbox()

    def deploy_project(self):
        wamp_path = self.wamp_dir.get()
        project_path = self.active_project.get()

        if not wamp_path:
            messagebox.showerror("Error", "Por favor, selecciona el directorio de WAMP/XAMPP.")
            return

        if not project_path:
            messagebox.showerror("Error", "Por favor, selecciona un proyecto activo.")
            return

        try:
            # Borrar contenido del directorio WAMP/XAMPP
            for filename in os.listdir(wamp_path):
                file_path = os.path.join(wamp_path, filename)
                if os.path.isfile(file_path) or os.path.islink(file_path):
                    os.unlink(file_path)
                elif os.path.isdir(file_path):
                    shutil.rmtree(file_path)

            # Copiar el contenido del proyecto al directorio WAMP/XAMPP
            for item in os.listdir(project_path):
                s = os.path.join(project_path, item)
                d = os.path.join(wamp_path, item)
                if os.path.isdir(s):
                    shutil.copytree(s, d)
                else:
                    shutil.copy2(s, d)

            messagebox.showinfo("Éxito", "El proyecto activo se ha desplegado correctamente.")
        except Exception as e:
            messagebox.showerror("Error", f"Ocurrió un error: {str(e)}")

if __name__ == "__main__":
    root = tk.Tk()
    app = DeployApp(root)
    root.mainloop()
